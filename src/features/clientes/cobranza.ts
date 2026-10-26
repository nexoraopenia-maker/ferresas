import { BusinessError } from '@/lib/errors'
import { generarCsv } from '@/lib/csv-export'
import { diaLocal, medianoche } from '@/lib/periodos'
import { puede } from '@/lib/puede'
import type { TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { hoyEnZona } from '@/features/credito/credito-service'
import {
  clasificarAntiguedad, diasDeMora, ETIQUETAS_TRAMO, TRAMOS_ANTIGUEDAD, type MontosPorTramo,
} from '@/features/credito/reglas'
import { PERMISOS_VER_COBRANZA } from './permisos'
import { puedeVerClientes } from './service'

/**
 * Cobranza: la antigüedad de la deuda, el estado de cuenta de un cliente y sus descargas en CSV. TODO ES DE SOLO LECTURA (salvo el
 * registro de cada descarga en la auditoría).
 *
 * Quién lo ve: lo mismo que ve clientes, más `reportes.ver` (el contador revisa la cartera sin poder editarla).
 *
 * Los tramos miden DÍAS DE MORA desde el vencimiento: lo que aún no vence va en «Vigente» y no se mezcla con la deuda atrasada.
 */

export { PERMISOS_VER_COBRANZA }
export function puedeVerCobranza(ctx: TenantContext): boolean {
  return PERMISOS_VER_COBRANZA.some((p) => puede(ctx, p))
}
function exigirVerCobranza(ctx: TenantContext): void {
  if (!puedeVerCobranza(ctx)) throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para ver la cobranza.')
}

const num = (d: { toString(): string } | null | undefined) => Number(d?.toString() ?? 0)
const cent = (n: number) => Math.round(n * 100) / 100
const dia = (d: Date) => d.toISOString().slice(0, 10)

// ─── Antigüedad ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface FilaCobranza extends MontosPorTramo {
  customerId: string; nombre: string; docType: string; docNumber: string | null; telefono: string | null
  /** Cuentas abiertas y los días de mora de la más atrasada (0 si ninguna venció). */
  cuentas: number; masAtrasada: number
}
export interface InformeCobranza {
  /** AAAA-MM-DD en la zona del negocio. */
  fecha: string
  filas: FilaCobranza[]
  totales: MontosPorTramo
  clientesConDeuda: number
  clientesMorosos: number
  /** Σ de la deuda guardada en los clientes. Si no coincide con `totales.total` la contabilidad del crédito no cuadra. */
  deudaEnClientes: number
  coherente: boolean
}

export async function informeDeCobranza(db: TenantPrismaClient, ctx: TenantContext): Promise<InformeCobranza> {
  exigirVerCobranza(ctx)
  const tenant = await db.tenant.findFirstOrThrow({ select: { timezone: true } })
  const hoy = hoyEnZona(tenant.timezone)

  const [cuentas, deuda] = await Promise.all([
    db.receivable.findMany({
      where: { status: 'ABIERTA' },
      select: { customerId: true, amount: true, paidAmount: true, dueDate: true, customer: { select: { name: true, docType: true, docNumber: true, phone: true } } },
    }),
    db.customer.aggregate({ _sum: { creditBalance: true } }),
  ])

  const porCliente = new Map<string, { c: (typeof cuentas)[number]['customer']; lista: { amount: number; paidAmount: number; dueDate: string }[] }>()
  for (const x of cuentas) {
    const e = porCliente.get(x.customerId) ?? { c: x.customer, lista: [] }
    e.lista.push({ amount: num(x.amount), paidAmount: num(x.paidAmount), dueDate: dia(x.dueDate) })
    porCliente.set(x.customerId, e)
  }
  const filas = [...porCliente].map(([customerId, e]): FilaCobranza => ({
    customerId, nombre: e.c.name, docType: e.c.docType, docNumber: e.c.docNumber, telefono: e.c.phone,
    ...clasificarAntiguedad(e.lista, hoy),
    cuentas: e.lista.length, masAtrasada: Math.max(0, ...e.lista.map((x) => diasDeMora(x.dueDate, hoy))),
  }))
  const orden = new Intl.Collator('es', { sensitivity: 'base', numeric: true })
  // Lo más urgente primero: mayor deuda vencida; a igualdad, por nombre.
  filas.sort((a, b) => b.vencido - a.vencido || orden.compare(a.nombre, b.nombre))

  const totales = clasificarAntiguedad(cuentas.map((x) => ({ amount: num(x.amount), paidAmount: num(x.paidAmount), dueDate: dia(x.dueDate) })), hoy)
  const deudaEnClientes = cent(num(deuda._sum.creditBalance))
  return {
    fecha: hoy, filas, totales, clientesConDeuda: filas.length, clientesMorosos: filas.filter((f) => f.vencido > 0).length,
    deudaEnClientes, coherente: Math.round(deudaEnClientes * 100) === Math.round(totales.total * 100),
  }
}

// ─── Estado de cuenta ───────────────────────────────────────────────────────────────────────────────────────────────

export interface EstadoDeCuenta {
  cliente: { id: string; nombre: string; docType: string; docNumber: string | null; telefono: string | null }
  /** AAAA-MM-DD; `null` = sin límite. */
  desde: string | null; hasta: string | null
  /** Hoy, en la zona del negocio. */
  fecha: string
  deudaActual: number
  /** Cuentas abiertas (todas, vencidas o no) y las cerradas cuya venta cae en el periodo. */
  cuentas: {
    venta: string; fecha: string; monto: number; abonado: number; saldo: number; vence: string
    estado: 'ABIERTA' | 'PAGADA' | 'ANULADA'; diasMora: number
  }[]
  abonos: { fecha: string; metodo: string; monto: number; referencia: string | null; cobradoPor: string; anulado: boolean; motivoAnulacion: string | null }[]
  totales: { fiadoEnElPeriodo: number; abonadoEnElPeriodo: number; anuladoEnElPeriodo: number }
}

export async function estadoDeCuenta(
  db: TenantPrismaClient, ctx: TenantContext, input: { customerId: string; desde?: string; hasta?: string },
): Promise<EstadoDeCuenta> {
  if (!puedeVerClientes(ctx)) throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para ver el estado de cuenta de un cliente.')
  const cliente = await db.customer.findFirst({
    where: { id: input.customerId },
    select: { id: true, name: true, docType: true, docNumber: true, phone: true, creditBalance: true, deletedAt: true },
  })
  if (!cliente || (cliente.deletedAt && !puede(ctx, 'clientes.gestionar'))) throw new BusinessError('NOT_FOUND', 'El cliente no existe.')

  const tenant = await db.tenant.findFirstOrThrow({ select: { timezone: true } })
  const hoy = hoyEnZona(tenant.timezone)
  const limite = (f: string | undefined, fin: boolean): Date | null => {
    if (!f) return null
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(f)
    if (!m) throw new BusinessError('INVALID_DOCUMENT', 'Las fechas van como AAAA-MM-DD.')
    const inicio = medianoche(tenant.timezone, Number(m[1]), Number(m[2]), Number(m[3]) + (fin ? 1 : 0))
    return inicio
  }
  const d = limite(input.desde, false), h = limite(input.hasta, true)
  if (d && h && d >= h) throw new BusinessError('INVALID_DOCUMENT', 'La fecha «hasta» debe ser igual o posterior a «desde».')
  const rango = (campo: 'createdAt' | 'receivedAt') => (d || h ? { [campo]: { ...(d ? { gte: d } : {}), ...(h ? { lt: h } : {}) } } : {})

  const [cuentas, abonos] = await Promise.all([
    db.receivable.findMany({
      where: { customerId: input.customerId, OR: [{ status: 'ABIERTA' }, { ...rango('createdAt') }] },
      orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: { amount: true, paidAmount: true, dueDate: true, status: true, createdAt: true, sale: { select: { number: true } } },
    }),
    db.customerPayment.findMany({
      where: { customerId: input.customerId, ...rango('receivedAt') },
      orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
      select: { receivedAt: true, method: true, amount: true, reference: true, voidedAt: true, voidReason: true, user: { select: { name: true } } },
    }),
  ])
  const filasCuenta = cuentas.map((x) => ({
    venta: x.sale.number, fecha: diaLocal(tenant.timezone, x.createdAt), monto: num(x.amount), abonado: num(x.paidAmount),
    saldo: cent(num(x.amount) - num(x.paidAmount)), vence: dia(x.dueDate), estado: x.status,
    diasMora: x.status === 'ABIERTA' ? Math.max(0, diasDeMora(dia(x.dueDate), hoy)) : 0,
  }))
  const filasAbono = abonos.map((a) => ({
    fecha: diaLocal(tenant.timezone, a.receivedAt), metodo: a.method, monto: num(a.amount), referencia: a.reference, cobradoPor: a.user.name,
    anulado: a.voidedAt !== null, motivoAnulacion: a.voidReason,
  }))
  const suma = (xs: number[]) => xs.reduce((a, n) => a + Math.round(n * 100), 0) / 100
  return {
    cliente: { id: cliente.id, nombre: cliente.name, docType: cliente.docType, docNumber: cliente.docNumber, telefono: cliente.phone },
    desde: input.desde ?? null, hasta: input.hasta ?? null, fecha: hoy, deudaActual: num(cliente.creditBalance),
    cuentas: filasCuenta, abonos: filasAbono,
    totales: {
      // El fiado del periodo cuenta las cuentas creadas en él, aunque una se haya castigado después: es lo que se vendió a crédito.
      fiadoEnElPeriodo: suma(cuentas.filter((x) => (!d || x.createdAt >= d) && (!h || x.createdAt < h)).map((x) => num(x.amount))),
      abonadoEnElPeriodo: suma(filasAbono.filter((a) => !a.anulado).map((a) => a.monto)),
      anuladoEnElPeriodo: suma(filasAbono.filter((a) => a.anulado).map((a) => a.monto)),
    },
  }
}

// ─── Descargas CSV ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface ArchivoCsv { nombre: string; contenido: string; filas: number }

async function auditarDescarga(db: TenantPrismaClient, ctx: TenantContext, accion: string, entityId: string, detalle: Record<string, unknown>) {
  await db.auditLog.create({
    data: {
      tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role, action: accion, entityType: 'Cobranza', entityId,
      after: detalle as never, impersonationId: ctx.impersonationId ?? null,
    },
  })
}

/** Antigüedad de la cobranza en CSV. Queda en la auditoría quién la descargó y cuántas filas llevaba. */
export async function exportarCobranzaCsv(db: TenantPrismaClient, ctx: TenantContext): Promise<ArchivoCsv> {
  const informe = await informeDeCobranza(db, ctx)
  const cabecera = ['Cliente', 'Documento', 'Teléfono', 'Cuentas', 'Días de mora (la más atrasada)', ...TRAMOS_ANTIGUEDAD.map((t) => ETIQUETAS_TRAMO[t]), 'Total adeudado', 'Total vencido']
  const filas = informe.filas.map((f) => [
    f.nombre, f.docNumber ? `${f.docType} ${f.docNumber}` : '', f.telefono ?? '', f.cuentas, f.masAtrasada,
    ...TRAMOS_ANTIGUEDAD.map((t) => ({ monto: f[t] })), { monto: f.total }, { monto: f.vencido },
  ])
  const t = informe.totales
  filas.push(['TOTAL', '', '', '', '', ...TRAMOS_ANTIGUEDAD.map((x) => ({ monto: t[x] })), { monto: t.total }, { monto: t.vencido }] as never)
  await auditarDescarga(db, ctx, 'cobranza.exportada', informe.fecha, { filas: informe.filas.length, totalAdeudado: t.total, totalVencido: t.vencido })
  return { nombre: `cobranza-${informe.fecha}.csv`, contenido: generarCsv(cabecera, filas), filas: informe.filas.length }
}

/** Estado de cuenta de un cliente en CSV: sus cuentas y sus abonos. */
export async function exportarEstadoDeCuentaCsv(
  db: TenantPrismaClient, ctx: TenantContext, input: { customerId: string; desde?: string; hasta?: string },
): Promise<ArchivoCsv> {
  const e = await estadoDeCuenta(db, ctx, input)
  const cabecera = ['Tipo', 'Fecha', 'Documento / método', 'Referencia', 'Monto', 'Abonado', 'Saldo', 'Vence', 'Estado', 'Días de mora', 'Cobrado por', 'Motivo de anulación']
  const filas = [
    ...e.cuentas.map((c) => ['Venta a crédito', c.fecha, c.venta, '', { monto: c.monto }, { monto: c.abonado }, { monto: c.saldo }, c.vence, c.estado, c.diasMora, '', '']),
    ...e.abonos.map((a) => ['Abono', a.fecha, a.metodo, a.referencia ?? '', { monto: a.monto }, '', '', '', a.anulado ? 'ANULADO' : 'VIGENTE', '', a.cobradoPor, a.motivoAnulacion ?? '']),
  ]
  filas.push(['DEUDA ACTUAL', e.fecha, '', '', '', '', { monto: e.deudaActual }, '', '', '', '', ''] as never)
  await auditarDescarga(db, ctx, 'estado_cuenta.exportado', e.cliente.id, { filas: e.cuentas.length + e.abonos.length, desde: e.desde, hasta: e.hasta })
  const slug = (e.cliente.docNumber ?? e.cliente.id).replace(/[^A-Za-z0-9]/g, '')
  return { nombre: `estado-de-cuenta-${slug}-${e.fecha}.csv`, contenido: generarCsv(cabecera, filas), filas: filas.length - 1 }
}


// ─── Resumen para el panel ──────────────────────────────────────────────────────────────────────────────────────────

export interface ResumenPorCobrar {
  total: number
  vencido: number
  vigente: number
  clientesConDeuda: number
  clientesMorosos: number
  /** Hasta tres clientes con más deuda vencida. */
  masUrgentes: { customerId: string; nombre: string; vencido: number; masAtrasada: number }[]
  coherente: boolean
}

/** La tarjeta «Por cobrar» del panel. Solo lectura; sale del mismo informe que la pantalla de cobranza, así que no pueden discrepar. */
export async function resumenPorCobrar(db: TenantPrismaClient, ctx: TenantContext): Promise<ResumenPorCobrar> {
  const i = await informeDeCobranza(db, ctx)
  return {
    total: i.totales.total, vencido: i.totales.vencido, vigente: i.totales.vigente,
    clientesConDeuda: i.clientesConDeuda, clientesMorosos: i.clientesMorosos,
    masUrgentes: i.filas.filter((f) => f.vencido > 0).slice(0, 3).map((f) => ({ customerId: f.customerId, nombre: f.nombre, vencido: f.vencido, masAtrasada: f.masAtrasada })),
    coherente: i.coherente,
  }
}
