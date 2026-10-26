import { Prisma } from '@/generated/prisma/client'
import { BusinessError } from '@/lib/errors'
import { validarDocumento } from '@/lib/documentos'
import { P2002_UNIQUE } from '@/lib/prisma-errors'
import { puede } from '@/lib/puede'
import { requireBranch, type TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { turnoAbiertoId } from '@/features/branches/queries'
import type { AnularAbonoInput, AnularCuentaInput, ConfigurarCreditoInput, DescartarRevisionInput, RegistrarAbonoInput } from './schemas'

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

// ═════════════════════════════════════════════════════════════════════════════════════════════════
//  ABONOS, ANULACIONES, CASTIGO Y REVISIÓN
// ═════════════════════════════════════════════════════════════════════════════════════════════════

const noExiste = (que: string) => new BusinessError('TENANT_MISMATCH', `${que} no existe.`)
const invalido = (m: string, d?: Record<string, string | number>) => new BusinessError('INVALID_DOCUMENT', m, d)
const soles = (c: number) => `S/ ${deCentimos(c).toFixed(2)}`

export interface RepartoAbono {
  receivableId: string
  /** Número de la venta que originó la deuda. */
  venta: string
  monto: number
  /** Lo que queda por pagar de esa cuenta después de este abono. */
  saldoDespues: number
  /** Con este abono la cuenta quedó pagada por completo. */
  pagada: boolean
}

export interface AbonoRegistrado {
  paymentId: string
  customerId: string
  method: string
  monto: number
  reparto: RepartoAbono[]
  /** `null` en un reintento: lo que valía antes ya no se puede reconstruir. */
  deudaAntes: number | null
  /** En un reintento es la deuda ACTUAL del cliente. */
  deudaDespues: number
  /** Fue un reintento del mismo envío: no se cobró otra vez. */
  replayed: boolean
}

/** El abono ya registrado con esa clave de idempotencia, listo para devolverse como reintento. */
async function abonoPorClave(t: TenantPrismaClient, idempotencyKey: string): Promise<AbonoRegistrado | null> {
  const p = await t.customerPayment.findFirst({
    where: { idempotencyKey },
    select: {
      id: true, customerId: true, method: true, amount: true,
      customer: { select: { creditBalance: true } },
      allocations: { select: { receivableId: true, amount: true, receivable: { select: { amount: true, paidAmount: true, status: true, sale: { select: { number: true } } } } } },
    },
  })
  if (!p) return null
  return {
    paymentId: p.id, customerId: p.customerId, method: p.method, monto: num(p.amount),
    reparto: p.allocations.map((a) => ({
      receivableId: a.receivableId, venta: a.receivable.sale.number, monto: num(a.amount),
      saldoDespues: deCentimos(aCentimos(num(a.receivable.amount)) - aCentimos(num(a.receivable.paidAmount))), pagada: a.receivable.status === 'PAGADA',
    })),
    deudaAntes: null, deudaDespues: num(p.customer.creditBalance), replayed: true,
  }
}

/**
 * Registra el abono de un cliente con deuda y lo reparte entre sus cuentas: la MÁS ANTIGUA primero (vencimiento, luego antigüedad),
 * o solo las que se elijan y en el orden en que se elijan. Todo en una transacción que EMPIEZA bloqueando al cliente.
 *
 *  · Idempotente: la clave es obligatoria; el mismo envío repetido devuelve el abono original y no cobra dos veces (también si dos
 *    llegan a la vez: el segundo espera el bloqueo del cliente y encuentra el primero).
 *  · Un abono nunca supera lo que el cliente debe en las cuentas a las que se aplica.
 *  · En EFECTIVO exige un turno de caja abierto (el dinero entra al arqueo); con otros medios, si hay turno abierto queda enlazado.
 */
export async function registrarAbono(db: TenantPrismaClient, ctx: TenantContext, input: RegistrarAbonoInput): Promise<AbonoRegistrado> {
  if (!puede(ctx, 'credito.cobrar')) throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para registrar abonos de clientes.')
  const branchId = requireBranch(ctx)

  const previo = await abonoPorClave(db, input.idempotencyKey)
  if (previo) return previo

  const turno = await turnoAbiertoId(db, branchId)
  if (input.method === 'EFECTIVO' && !turno) {
    throw invalido('Abre la caja antes de cobrar un abono en efectivo: ese dinero tiene que entrar a un turno.')
  }

  try {
    return await db.$transaction(async (tx) => {
      const t = tx as unknown as TenantPrismaClient
      const cliente = await bloquearCliente(t, input.customerId)   // ← siempre lo primero
      const dup = await abonoPorClave(t, input.idempotencyKey)       // dos envíos a la vez: el segundo llega aquí tras esperar el bloqueo
      if (dup) return dup
      if (cliente.deletedAt) throw noExiste('El cliente')

      const abiertas = await t.receivable.findMany({
        where: { customerId: input.customerId, status: 'ABIERTA' },
        orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, amount: true, paidAmount: true, sale: { select: { number: true } } },
      })
      let destino = abiertas
      if (input.receivableIds) {
        const porId = new Map(abiertas.map((r) => [r.id, r]))
        destino = input.receivableIds.map((id) => {
          const r = porId.get(id)
          if (!r) throw invalido('Una de las cuentas elegidas no está abierta o no es de este cliente.')
          return r
        })
      }
      const saldos = destino.map((r) => aCentimos(num(r.amount)) - aCentimos(num(r.paidAmount)))
      const deudaElegida = saldos.reduce((a, b) => a + b, 0)
      if (deudaElegida <= 0) throw invalido('El cliente no tiene deuda pendiente.')
      const M = aCentimos(input.amount)
      if (M > deudaElegida) {
        throw invalido(
          `El abono (${soles(M)}) supera lo que el cliente debe${input.receivableIds ? ' en las cuentas elegidas' : ''} (${soles(deudaElegida)}).`,
          { abono: deCentimos(M), deuda: deCentimos(deudaElegida) },
        )
      }

      const pago = await t.customerPayment.create({
        data: {
          tenantId: ctx.tenantId, customerId: input.customerId, branchId, cashSessionId: turno, userId: ctx.userId,
          method: input.method, amount: deCentimos(M), reference: input.reference ?? null, notes: input.notes ?? null,
          idempotencyKey: input.idempotencyKey,
        },
        select: { id: true },
      })

      const reparto: RepartoAbono[] = []
      let resto = M
      for (let i = 0; i < destino.length && resto > 0; i++) {
        const r = destino[i]!
        const a = Math.min(resto, saldos[i]!)
        if (a <= 0) continue
        resto -= a
        const pagado = aCentimos(num(r.paidAmount)) + a
        const total = aCentimos(num(r.amount))
        const cerrada = pagado === total
        await t.paymentAllocation.create({ data: { tenantId: ctx.tenantId, customerPaymentId: pago.id, receivableId: r.id, amount: deCentimos(a) }, select: { id: true } })
        await t.receivable.update({
          where: { id: r.id },
          data: cerrada ? { paidAmount: deCentimos(pagado), status: 'PAGADA', closedAt: new Date() } : { paidAmount: deCentimos(pagado) },
          select: { id: true },
        })
        reparto.push({ receivableId: r.id, venta: r.sale.number, monto: deCentimos(a), saldoDespues: deCentimos(total - pagado), pagada: cerrada })
      }

      await t.customer.update({ where: { id: input.customerId }, data: { creditBalance: { decrement: deCentimos(M) } }, select: { id: true } })
      const deudaAntes = cliente.creditBalance
      const deudaDespues = deCentimos(aCentimos(deudaAntes) - M)
      await t.auditLog.create({
        data: {
          tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role,
          action: 'credito.abono', entityType: 'CustomerPayment', entityId: pago.id,
          after: { cliente: cliente.name, monto: deCentimos(M), metodo: input.method, reparto: reparto.map((r) => ({ venta: r.venta, monto: r.monto, pagada: r.pagada })), deudaAntes, deudaDespues },
          impersonationId: ctx.impersonationId ?? null,
        },
      })
      return { paymentId: pago.id, customerId: input.customerId, method: input.method, monto: deCentimos(M), reparto, deudaAntes, deudaDespues, replayed: false }
    }, { maxWait: 15_000, timeout: 30_000 })
  } catch (e) {
    // Dos envíos simultáneos con la misma clave: uno ganó el índice único y el otro se deshizo entero. Solo si de verdad existe.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === P2002_UNIQUE) {
      const ganador = await abonoPorClave(db, input.idempotencyKey)
      if (ganador) return ganador
    }
    throw e
  }
}

/**
 * Anula un abono: devuelve lo repartido a sus cuentas (una cuenta PAGADA vuelve a ABIERTA) y restituye la deuda del cliente
 * (`credito.castigar`, con motivo). Nunca borra: el abono queda marcado con quién, cuándo y por qué.
 *
 * UN TURNO CERRADO ES INMUTABLE: si el abono está enlazado a un turno ya cerrado no se anula; el arqueo congelado no se reescribe.
 * Un error descubierto después del cierre se corrige con un ingreso o egreso manual justificado por la administración.
 */
export async function anularAbono(db: TenantPrismaClient, ctx: TenantContext, input: AnularAbonoInput): Promise<{ paymentId: string; deudaDespues: number }> {
  if (!puede(ctx, 'credito.castigar')) throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para anular abonos.')
  return db.$transaction(async (tx) => {
    const t = tx as unknown as TenantPrismaClient
    const previo = await t.customerPayment.findFirst({ where: { id: input.paymentId }, select: { customerId: true } })
    if (!previo) throw noExiste('El abono')
    const cliente = await bloquearCliente(t, previo.customerId)   // ← primero; luego se vuelve a leer el abono con el estado ya firme

    const pago = await t.customerPayment.findFirst({
      where: { id: input.paymentId },
      select: {
        id: true, amount: true, voidedAt: true, cashSessionId: true, cashSession: { select: { status: true } },
        allocations: { select: { receivableId: true, amount: true } },
      },
    })
    if (!pago) throw noExiste('El abono')
    if (pago.voidedAt) throw invalido('Este abono ya está anulado.')
    if (pago.cashSessionId && pago.cashSession?.status !== 'ABIERTA') {
      throw invalido('El turno de caja de este abono ya cerró y un turno cerrado no se modifica: haz el ajuste como ingreso o egreso manual justificado por la administración.')
    }
    if (cliente.deletedAt) throw new BusinessError('CREDIT_BLOCKED', 'El cliente está dado de baja: no se puede reabrir su deuda.')

    let restituido = 0
    for (const a of pago.allocations) {
      const r = await t.receivable.findFirst({ where: { id: a.receivableId }, select: { amount: true, paidAmount: true, status: true } })
      if (!r) throw noExiste('La cuenta')
      const monto = aCentimos(num(a.amount))
      const pagado = aCentimos(num(r.paidAmount)) - monto
      const datos = r.status === 'PAGADA' ? { paidAmount: deCentimos(pagado), status: 'ABIERTA' as const, closedAt: null } : { paidAmount: deCentimos(pagado) }
      await t.receivable.update({ where: { id: a.receivableId }, data: datos, select: { id: true } })
      // Una cuenta ya ANULADA no cuenta en la deuda: devolverle lo abonado no la reabre ni toca el saldo.
      if (r.status !== 'ANULADA') restituido += monto
    }
    if (restituido > 0) {
      await t.customer.update({ where: { id: previo.customerId }, data: { creditBalance: { increment: deCentimos(restituido) } }, select: { id: true } })
    }
    await t.customerPayment.update({
      where: { id: pago.id },
      data: { voidedAt: new Date(), voidedById: ctx.userId, voidReason: input.motivo },
      select: { id: true },
    })
    const deudaDespues = deCentimos(aCentimos(cliente.creditBalance) + restituido)
    await t.auditLog.create({
      data: {
        tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role,
        action: 'credito.abono_anulado', entityType: 'CustomerPayment', entityId: pago.id, reason: input.motivo,
        after: { cliente: cliente.name, monto: num(pago.amount), restituido: deCentimos(restituido), deudaAntes: cliente.creditBalance, deudaDespues },
        impersonationId: ctx.impersonationId ?? null,
      },
    })
    return { paymentId: pago.id, deudaDespues }
  }, { maxWait: 15_000, timeout: 30_000 })
}

/**
 * Da de baja una cuenta por cobrar con saldo (castigo de una deuda incobrable, error, nota de crédito aceptada): `credito.castigar`,
 * con motivo. El saldo que quedaba sale de la deuda del cliente; lo ya abonado se conserva en el historial. Solo cuentas ABIERTAS.
 */
export async function anularCuenta(db: TenantPrismaClient, ctx: TenantContext, input: AnularCuentaInput): Promise<{ receivableId: string; saldoCastigado: number; deudaDespues: number }> {
  if (!puede(ctx, 'credito.castigar')) throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para dar de baja una deuda.')
  return db.$transaction(async (tx) => {
    const t = tx as unknown as TenantPrismaClient
    const previa = await t.receivable.findFirst({ where: { id: input.receivableId }, select: { customerId: true } })
    if (!previa) throw noExiste('La cuenta')
    const cliente = await bloquearCliente(t, previa.customerId)

    const r = await t.receivable.findFirst({ where: { id: input.receivableId }, select: { id: true, amount: true, paidAmount: true, status: true, sale: { select: { number: true } } } })
    if (!r) throw noExiste('La cuenta')
    if (r.status === 'ANULADA') throw invalido('Esta cuenta ya está dada de baja.')
    if (r.status === 'PAGADA') throw invalido('Esta cuenta ya está pagada por completo: no hay saldo que dar de baja.')
    const saldo = aCentimos(num(r.amount)) - aCentimos(num(r.paidAmount))

    const ahora = new Date()
    await t.receivable.update({ where: { id: r.id }, data: { status: 'ANULADA', voidedAt: ahora, closedAt: ahora, voidReason: input.motivo }, select: { id: true } })
    await t.customer.update({ where: { id: previa.customerId }, data: { creditBalance: { decrement: deCentimos(saldo) } }, select: { id: true } })
    const deudaDespues = deCentimos(aCentimos(cliente.creditBalance) - saldo)
    await t.auditLog.create({
      data: {
        tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role,
        action: 'credito.cuenta_anulada', entityType: 'Receivable', entityId: r.id, reason: input.motivo,
        after: { venta: r.sale.number, cliente: cliente.name, monto: num(r.amount), abonado: num(r.paidAmount), saldoCastigado: deCentimos(saldo), deudaAntes: cliente.creditBalance, deudaDespues },
        impersonationId: ctx.impersonationId ?? null,
      },
    })
    return { receivableId: r.id, saldoCastigado: deCentimos(saldo), deudaDespues }
  }, { maxWait: 15_000, timeout: 30_000 })
}

/**
 * Marca la cuenta de una venta como «pendiente de revisión» porque se le emitió una nota de crédito. NO la anula ni toca la deuda:
 * decidir si se perdona o se mantiene es del dueño (`anularCuenta` o `descartarRevision`). Se llama DENTRO de la transacción que
 * emite la nota (por eso recibe el cliente transaccional), de modo que la nota y la marca nacen juntas o no nacen.
 * Devuelve `true` si había una cuenta viva que marcar.
 */
export async function marcarRevisionPorNota(
  t: TenantPrismaClient,
  ctx: TenantContext,
  input: { saleId: string; nota: string; motivo: string },
): Promise<boolean> {
  const r = await t.receivable.findFirst({ where: { saleId: input.saleId }, select: { id: true, status: true } })
  if (!r || r.status === 'ANULADA') return false
  const razon = `Nota de crédito ${input.nota}: ${input.motivo}`.slice(0, 300)
  await t.receivable.update({ where: { id: r.id }, data: { reviewRequestedAt: new Date(), reviewReason: razon }, select: { id: true } })
  await t.auditLog.create({
    data: {
      tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role,
      action: 'credito.revision_marcada', entityType: 'Receivable', entityId: r.id, reason: razon,
      after: { nota: input.nota, estadoCuenta: r.status },
      impersonationId: ctx.impersonationId ?? null,
    },
  })
  return true
}

/** El dueño revisó la cuenta marcada por una nota de crédito y decide MANTENERLA: quita la marca y deja la nota escrita (`credito.castigar`). */
export async function descartarRevision(db: TenantPrismaClient, ctx: TenantContext, input: DescartarRevisionInput): Promise<{ receivableId: string }> {
  if (!puede(ctx, 'credito.castigar')) throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para resolver la revisión de una deuda.')
  return db.$transaction(async (tx) => {
    const t = tx as unknown as TenantPrismaClient
    const r = await t.receivable.findFirst({ where: { id: input.receivableId }, select: { id: true, reviewRequestedAt: true, reviewReason: true } })
    if (!r) throw noExiste('La cuenta')
    if (!r.reviewRequestedAt) throw invalido('Esta cuenta no está pendiente de revisión.')
    await t.receivable.update({ where: { id: r.id }, data: { reviewRequestedAt: null, reviewReason: null }, select: { id: true } })
    await t.auditLog.create({
      data: {
        tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role,
        action: 'credito.revision_descartada', entityType: 'Receivable', entityId: r.id, reason: input.nota,
        before: { revision: r.reviewReason }, after: { decision: 'MANTENER' },
        impersonationId: ctx.impersonationId ?? null,
      },
    })
    return { receivableId: r.id }
  })
}
