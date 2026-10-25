import { BusinessError } from '@/lib/errors'
import { validarDocumento } from '@/lib/documentos'
import { puede } from '@/lib/puede'
import type { TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import type { ConfigurarCreditoInput } from './schemas'

/**
 * Crédito (fiado): línea de cada cliente, deuda viva y cuentas por cobrar.
 *
 * ─── LA REGLA QUE LO SOSTIENE: BLOQUEAR AL CLIENTE PRIMERO ───────────────
 *
 * Toda operación que cambia la deuda de un cliente (fiar, abonar, anular) EMPIEZA bloqueando la fila del cliente con un UPDATE
 * (`creditBalance += 0`). Ese UPDATE devuelve la fila ya bloqueada y FRESCA: lo que se lee ahí es lo último confirmado, y nadie
 * más puede cambiar esa deuda hasta que esta transacción termine.
 *
 * Sin eso, dos cajas que fían al mismo cliente a la vez leerían el mismo saldo, las dos verían «cabe» y entre las dos pasarían
 * la línea. Con el bloqueo la segunda espera, lee el saldo ya actualizado por la primera y se rechaza si no cabe.
 *
 * Es Prisma puro (nada de SQL crudo), así que pasa por el aislamiento por negocio. Y como TODOS los caminos bloquean al cliente
 * antes de tocar cuentas o abonos, no hay interbloqueos: el orden de bloqueo es siempre el mismo.
 *
 * `Customer.creditBalance` es una CACHÉ de Σ (monto − abonado) de las cuentas abiertas, mantenida en la misma transacción que
 * la cuenta. Nunca se escribe suelta; una auditoría (3.5) la compara con la suma real.
 */

const aCentimos = (n: number) => Math.round(n * 100)
const deCentimos = (c: number) => c / 100
const num = (d: { toString(): string } | number | null | undefined) => Number(d?.toString() ?? 0)

/** Hoy (AAAA-MM-DD) en la zona horaria del negocio: un fiado de las 11 pm no vence «mañana» por culpa del reloj del servidor. */
export function hoyEnZona(zona: string, ahora: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zona, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ahora)
}

/** Fecha sin hora (UTC medianoche) = `fecha` + `dias`. Es lo que guarda una columna `@db.Date`. */
export function sumarDias(fecha: string, dias: number): Date {
  const [y, m, d] = fecha.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d + dias))
}

/** Lo que hace falta saber de un cliente para decidir si se le puede fiar. */
export interface ClienteCredito {
  name: string
  docType: string
  docNumber: string | null
  isActive: boolean
  deletedAt: Date | null
  creditLimit: number
  creditBalance: number
  creditBlockedAt: Date | null
  creditTermDays: number
}

/** El cliente tiene un DNI o RUC válido: no se fía a «público general» ni a quien no se podría cobrar. */
export function tieneDocumentoValido(c: Pick<ClienteCredito, 'docType' | 'docNumber'>): boolean {
  if (c.docType === 'SIN_DOCUMENTO' || !c.docNumber) return false
  return validarDocumento(c.docNumber).valido
}

/**
 * ¿Se le puede fiar `monto` a este cliente? Lanza el error que corresponde, o no hace nada. Lógica pura: se prueba sin base.
 * Orden: de baja → sin documento → bloqueado → sin línea → supera la línea.
 */
export function validarFiado(c: ClienteCredito, monto: number): void {
  if (c.deletedAt || !c.isActive) throw new BusinessError('CREDIT_BLOCKED', 'El cliente está dado de baja: no se le puede vender a crédito.')
  if (!tieneDocumentoValido(c)) {
    throw new BusinessError('CREDIT_CUSTOMER', 'Para fiar el cliente necesita un DNI o RUC válido: no se fía a «público general».')
  }
  if (c.creditBlockedAt) throw new BusinessError('CREDIT_BLOCKED', 'El crédito de este cliente está bloqueado.')
  const limite = aCentimos(c.creditLimit)
  if (limite <= 0) throw new BusinessError('CREDIT_BLOCKED', 'Este cliente no tiene línea de crédito.')
  const deuda = aCentimos(c.creditBalance)
  const M = aCentimos(monto)
  if (deuda + M > limite) {
    const disponible = Math.max(0, limite - deuda)
    throw new BusinessError(
      'CREDIT_LIMIT',
      `Supera la línea de crédito: disponible S/ ${deCentimos(disponible).toFixed(2)} de S/ ${deCentimos(limite).toFixed(2)}.`,
      { limite: deCentimos(limite), deuda: deCentimos(deuda), monto: deCentimos(M), disponible: deCentimos(disponible) },
    )
  }
}

const SELECCION_CLIENTE = {
  name: true, docType: true, docNumber: true, isActive: true, deletedAt: true,
  creditLimit: true, creditBalance: true, creditBlockedAt: true, creditTermDays: true,
} as const

type FilaCliente = {
  name: string; docType: string; docNumber: string | null; isActive: boolean; deletedAt: Date | null
  creditLimit: { toString(): string }; creditBalance: { toString(): string }; creditBlockedAt: Date | null; creditTermDays: number
}
const aClienteCredito = (f: FilaCliente): ClienteCredito => ({
  name: f.name, docType: f.docType, docNumber: f.docNumber, isActive: f.isActive, deletedAt: f.deletedAt,
  creditLimit: num(f.creditLimit), creditBalance: num(f.creditBalance), creditBlockedAt: f.creditBlockedAt, creditTermDays: f.creditTermDays,
})

/**
 * BLOQUEA al cliente y devuelve su fila fresca. Es el primer paso de toda operación de crédito (ver arriba).
 * Debe llamarse dentro de una transacción: fuera de ella el bloqueo se suelta al instante y no protege nada.
 */
export async function bloquearCliente(t: TenantPrismaClient, customerId: string) {
  try {
    const fila = await t.customer.update({ where: { id: customerId }, data: { creditBalance: { increment: 0 } }, select: SELECCION_CLIENTE })
    return aClienteCredito(fila)
  } catch (e) {
    if ((e as { code?: string }).code === 'P2025') throw new BusinessError('TENANT_MISMATCH', 'El cliente no existe.')
    throw e
  }
}

export interface FiadoOtorgado {
  receivableId: string
  monto: number
  /** Día de vencimiento, AAAA-MM-DD en la zona del negocio. */
  vence: string
  deudaAntes: number
  deudaDespues: number
}

/**
 * Registra el fiado de UNA venta, dentro de la transacción de la venta: bloquea al cliente, comprueba que se le pueda fiar y que
 * quepa en su línea, crea la cuenta por cobrar y sube su deuda. Si algo falla después (stock, numeración…) todo se deshace junto.
 */
export async function otorgarCredito(
  t: TenantPrismaClient,
  ctx: TenantContext,
  input: { customerId: string; saleId: string; saleNumber: string; monto: number },
): Promise<FiadoOtorgado> {
  const monto = deCentimos(aCentimos(input.monto))
  if (!(monto > 0)) throw new BusinessError('INVALID_DOCUMENT', 'El monto a fiar debe ser mayor que cero.')

  const cliente = await bloquearCliente(t, input.customerId)   // ← siempre lo primero
  validarFiado(cliente, monto)

  const { timezone } = await t.tenant.findFirstOrThrow({ select: { timezone: true } })
  const vence = hoyEnZona(timezone)
  const dueDate = sumarDias(vence, cliente.creditTermDays)

  const cuenta = await t.receivable.create({
    data: { tenantId: ctx.tenantId, customerId: input.customerId, saleId: input.saleId, amount: monto, dueDate },
    select: { id: true, dueDate: true },
  })
  const deudaAntes = cliente.creditBalance
  const deudaDespues = deCentimos(aCentimos(deudaAntes) + aCentimos(monto))
  await t.customer.update({ where: { id: input.customerId }, data: { creditBalance: { increment: monto } }, select: { id: true } })

  const venceTexto = cuenta.dueDate.toISOString().slice(0, 10)
  await t.auditLog.create({
    data: {
      tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role,
      action: 'credito.otorgado', entityType: 'Receivable', entityId: cuenta.id,
      after: { venta: input.saleNumber, cliente: cliente.name, monto, vence: venceTexto, deudaAntes, deudaDespues, limite: cliente.creditLimit },
      impersonationId: ctx.impersonationId ?? null,
    },
  })
  return { receivableId: cuenta.id, monto, vence: venceTexto, deudaAntes, deudaDespues }
}

export interface CreditoConfigurado {
  creditLimit: number
  creditTermDays: number
  bloqueado: boolean
  creditBalance: number
}

/**
 * Cambia la línea de crédito, el plazo o el bloqueo de un cliente (`credito.limite`). Todo queda auditado con el antes y el después.
 *
 * Bajar la línea por debajo de la deuda actual está permitido: simplemente no se le fía más hasta que pague. Dar línea a un cliente
 * sin documento válido NO: no habría a quién cobrarle.
 */
export async function configurarCredito(db: TenantPrismaClient, ctx: TenantContext, input: ConfigurarCreditoInput): Promise<CreditoConfigurado> {
  if (!puede(ctx, 'credito.limite')) {
    throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para cambiar la línea de crédito de un cliente.')
  }
  return db.$transaction(async (tx) => {
    const t = tx as unknown as TenantPrismaClient
    const antes = await bloquearCliente(t, input.customerId)
    if (antes.deletedAt) throw new BusinessError('TENANT_MISMATCH', 'El cliente no existe.')
    if (input.creditLimit > 0 && !tieneDocumentoValido(antes)) {
      throw new BusinessError('CREDIT_CUSTOMER', 'Para darle línea de crédito el cliente necesita un DNI o RUC válido.')
    }
    const bloqueadoAntes = !!antes.creditBlockedAt
    const creditBlockedAt = input.bloqueado ? (antes.creditBlockedAt ?? new Date()) : null
    await t.customer.update({
      where: { id: input.customerId },
      data: { creditLimit: input.creditLimit, creditTermDays: input.creditTermDays, creditBlockedAt },
      select: { id: true },
    })
    await t.auditLog.create({
      data: {
        tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role,
        action: 'credito.configurado', entityType: 'Customer', entityId: input.customerId,
        reason: input.motivo ?? null,
        before: { creditLimit: antes.creditLimit, creditTermDays: antes.creditTermDays, bloqueado: bloqueadoAntes },
        after: { creditLimit: input.creditLimit, creditTermDays: input.creditTermDays, bloqueado: input.bloqueado, deuda: antes.creditBalance },
        impersonationId: ctx.impersonationId ?? null,
      },
    })
    return { creditLimit: input.creditLimit, creditTermDays: input.creditTermDays, bloqueado: input.bloqueado, creditBalance: antes.creditBalance }
  })
}
