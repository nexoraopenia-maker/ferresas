import { BusinessError } from '@/lib/errors'
import { generarCsv } from '@/lib/csv-export'
import { diaLocal, medianoche } from '@/lib/periodos'
import { puede } from '@/lib/puede'
import type { TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import {
  clasificarAntiguedad, diasDeMora, ETIQUETAS_TRAMO, hoyEnZona, TRAMOS_ANTIGUEDAD, type MontosPorTramo,
} from '@/features/credito/reglas'
import { puedeVerPorPagar } from './permisos'
import type { EstadoCuentaProveedorInput } from './schemas'

/**
 * Cuentas por pagar: antigüedad de la deuda con los proveedores, estado de cuenta de uno y sus descargas en CSV. TODO ES DE SOLO LECTURA
 * (salvo el registro de cada descarga en la auditoría). Quién lo ve: ver `PERMISOS_VER_POR_PAGAR` (el contador incluido).
 *
 * Los tramos miden DÍAS DE MORA desde el vencimiento, con las mismas funciones puras que la cobranza: lo que aún no vence va en «Vigente».
 */

export { puedeVerPorPagar }
function exigirVer(ctx: TenantContext): void {
  if (!puedeVerPorPagar(ctx)) throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para ver las cuentas por pagar.')
}

const num = (d: { toString(): string } | null | undefined) => Number(d?.toString() ?? 0)
const cent = (n: number) => Math.round(n * 100) / 100
const dia = (d: Date) => d.toISOString().slice(0, 10)

// ─── Antigüedad ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface FilaPorPagar extends MontosPorTramo {
  supplierId: string; nombre: string; ruc: string | null; telefono: string | null
  /** Cuentas abiertas y los días de mora de la más atrasada (0 si ninguna venció). */
  cuentas: number; masAtrasada: number
}
export interface InformePorPagar {
  /** AAAA-MM-DD en la zona del negocio. */
  fecha: string
  filas: FilaPorPagar[]
  totales: MontosPorTramo
  proveedoresConDeuda: number
  proveedoresVencidos: number
  /** Σ de la deuda guardada en los proveedores. Si no coincide con `totales.total` la contabilidad no cuadra. */
  deudaEnProveedores: number
  coherente: boolean
}

export async function informeDePorPagar(db: TenantPrismaClient, ctx: TenantContext): Promise<InformePorPagar> {
  exigirVer(ctx)
  const tenant = await db.tenant.findFirstOrThrow({ select: { timezone: true } })
  const hoy = hoyEnZona(tenant.timezone)

  const [cuentas, deuda] = await Promise.all([
    db.accountPayable.findMany({
      where: { status: 'ABIERTA' },
      select: { supplierId: true, amount: true, paidAmount: true, dueDate: true, supplier: { select: { name: true, taxId: true, phone: true } } },
    }),
    db.supplier.aggregate({ _sum: { payableBalance: true } }),
  ])

  const porProveedor = new Map<string, { p: (typeof cuentas)[number]['supplier']; lista: { amount: number; paidAmount: number; dueDate: string }[] }>()
  for (const x of cuentas) {
    const e = porProveedor.get(x.supplierId) ?? { p: x.supplier, lista: [] }
    e.lista.push({ amount: num(x.amount), paidAmount: num(x.paidAmount), dueDate: dia(x.dueDate) })
    porProveedor.set(x.supplierId, e)
  }
  const filas = [...porProveedor].map(([supplierId, e]): FilaPorPagar => ({
    supplierId, nombre: e.p.name, ruc: e.p.taxId, telefono: e.p.phone,
    ...clasificarAntiguedad(e.lista, hoy),
    cuentas: e.lista.length, masAtrasada: Math.max(0, ...e.lista.map((x) => diasDeMora(x.dueDate, hoy))),
  }))
  const orden = new Intl.Collator('es', { sensitivity: 'base', numeric: true })
  // Lo más urgente primero: mayor deuda vencida; a igualdad, por nombre.
  filas.sort((a, b) => b.vencido - a.vencido || orden.compare(a.nombre, b.nombre))

  const totales = clasificarAntiguedad(cuentas.map((x) => ({ amount: num(x.amount), paidAmount: num(x.paidAmount), dueDate: dia(x.dueDate) })), hoy)
  const deudaEnProveedores = cent(num(deuda._sum.payableBalance))
  return {
    fecha: hoy, filas, totales, proveedoresConDeuda: filas.length, proveedoresVencidos: filas.filter((f) => f.vencido > 0).length,
    deudaEnProveedores, coherente: Math.round(deudaEnProveedores * 100) === Math.round(totales.total * 100),
  }
}

// ─── Estado de cuenta de un proveedor ───────────────────────────────────────────────────────────────────────────────

export interface EstadoDeCuentaProveedor {
  proveedor: { id: string; nombre: string; ruc: string | null; telefono: string | null; plazoDias: number }
  desde: string | null; hasta: string | null
  /** Hoy, en la zona del negocio. */
  fecha: string
  deudaActual: number
  /** Cuentas abiertas (todas, vencidas o no) y las cerradas cuya compra cae en el periodo. */
  cuentas: {
    compra: string; documento: string | null; fecha: string; monto: number; pagado: number; saldo: number; vence: string
    estado: 'ABIERTA' | 'PAGADA' | 'ANULADA'; diasMora: number
  }[]
  pagos: { fecha: string; metodo: string; monto: number; referencia: string | null; pagadoPor: string; anulado: boolean; motivoAnulacion: string | null; deCaja: boolean }[]
  totales: { compradoACreditoEnElPeriodo: number; pagadoEnElPeriodo: number; anuladoEnElPeriodo: number }
}

export async function estadoDeCuentaProveedor(db: TenantPrismaClient, ctx: TenantContext, input: EstadoCuentaProveedorInput): Promise<EstadoDeCuentaProveedor> {
  exigirVer(ctx)
  const p = await db.supplier.findFirst({
    where: { id: input.supplierId },
    select: { id: true, name: true, taxId: true, phone: true, paymentTermDays: true, payableBalance: true, deletedAt: true },
  })
  if (!p || (p.deletedAt && !puede(ctx, 'proveedores.gestionar'))) throw new BusinessError('NOT_FOUND', 'El proveedor no existe.')

  const tenant = await db.tenant.findFirstOrThrow({ select: { timezone: true } })
  const hoy = hoyEnZona(tenant.timezone)
  const limite = (f: string | undefined, fin: boolean): Date | null => {
    if (!f) return null
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(f)
    if (!m) throw new BusinessError('INVALID_DOCUMENT', 'Las fechas van como AAAA-MM-DD.')
    return medianoche(tenant.timezone, Number(m[1]), Number(m[2]), Number(m[3]) + (fin ? 1 : 0))
  }
  const d = limite(input.desde, false), h = limite(input.hasta, true)
  if (d && h && d >= h) throw new BusinessError('INVALID_DOCUMENT', 'La fecha «hasta» debe ser igual o posterior a «desde».')
  const rango = (campo: 'createdAt' | 'paidAt') => (d || h ? { [campo]: { ...(d ? { gte: d } : {}), ...(h ? { lt: h } : {}) } } : {})

  const [cuentas, pagos] = await Promise.all([
    db.accountPayable.findMany({
      where: { supplierId: input.supplierId, OR: [{ status: 'ABIERTA' }, { ...rango('createdAt') }] },
      orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: { amount: true, paidAmount: true, dueDate: true, status: true, createdAt: true, purchase: { select: { number: true, invoiceRef: true, notes: true } } },
    }),
    db.supplierPayment.findMany({
      where: { supplierId: input.supplierId, ...rango('paidAt') },
      orderBy: [{ paidAt: 'asc' }, { id: 'asc' }],
      select: { paidAt: true, method: true, amount: true, reference: true, voidedAt: true, voidReason: true, cashSessionId: true, user: { select: { name: true } } },
    }),
  ])
  const filasCuenta = cuentas.map((x) => ({
    compra: x.purchase.number, documento: x.purchase.invoiceRef, fecha: diaLocal(tenant.timezone, x.createdAt), monto: num(x.amount), pagado: num(x.paidAmount),
    saldo: cent(num(x.amount) - num(x.paidAmount)), vence: dia(x.dueDate), estado: x.status,
    diasMora: x.status === 'ABIERTA' ? Math.max(0, diasDeMora(dia(x.dueDate), hoy)) : 0,
  }))
  const filasPago = pagos.map((a) => ({
    fecha: diaLocal(tenant.timezone, a.paidAt), metodo: a.method, monto: num(a.amount), referencia: a.reference, pagadoPor: a.user.name,
    anulado: a.voidedAt !== null, motivoAnulacion: a.voidReason, deCaja: a.cashSessionId !== null && a.method === 'EFECTIVO',
  }))
  const suma = (xs: number[]) => xs.reduce((a, n) => a + Math.round(n * 100), 0) / 100
  return {
    proveedor: { id: p.id, nombre: p.name, ruc: p.taxId, telefono: p.phone, plazoDias: p.paymentTermDays },
    desde: input.desde ?? null, hasta: input.hasta ?? null, fecha: hoy, deudaActual: num(p.payableBalance),
    cuentas: filasCuenta, pagos: filasPago,
    totales: {
      // Lo comprado a crédito en el periodo cuenta las cuentas creadas en él, aunque una se haya anulado después.
      compradoACreditoEnElPeriodo: suma(cuentas.filter((x) => (!d || x.createdAt >= d) && (!h || x.createdAt < h)).map((x) => num(x.amount))),
      pagadoEnElPeriodo: suma(filasPago.filter((a) => !a.anulado).map((a) => a.monto)),
      anuladoEnElPeriodo: suma(filasPago.filter((a) => a.anulado).map((a) => a.monto)),
    },
  }
}

// ─── Descargas CSV ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface ArchivoCsv { nombre: string; contenido: string; filas: number }

async function auditarDescarga(db: TenantPrismaClient, ctx: TenantContext, accion: string, entityId: string, detalle: Record<string, unknown>) {
  await db.auditLog.create({
    data: {
      tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role, action: accion, entityType: 'PorPagar', entityId,
      after: detalle as never, impersonationId: ctx.impersonationId ?? null,
    },
  })
}

/** Antigüedad de la deuda con proveedores en CSV. Queda en la auditoría quién la descargó y cuántas filas llevaba. */
export async function exportarPorPagarCsv(db: TenantPrismaClient, ctx: TenantContext): Promise<ArchivoCsv> {
  const informe = await informeDePorPagar(db, ctx)
  const cabecera = ['Proveedor', 'RUC', 'Teléfono', 'Cuentas', 'Días de mora (la más atrasada)', ...TRAMOS_ANTIGUEDAD.map((t) => ETIQUETAS_TRAMO[t]), 'Total adeudado', 'Total vencido']
  const filas = informe.filas.map((f) => [
    f.nombre, f.ruc ?? '', f.telefono ?? '', f.cuentas, f.masAtrasada,
    ...TRAMOS_ANTIGUEDAD.map((t) => ({ monto: f[t] })), { monto: f.total }, { monto: f.vencido },
  ])
  const t = informe.totales
  filas.push(['TOTAL', '', '', '', '', ...TRAMOS_ANTIGUEDAD.map((x) => ({ monto: t[x] })), { monto: t.total }, { monto: t.vencido }] as never)
  await auditarDescarga(db, ctx, 'por_pagar.exportada', informe.fecha, { filas: informe.filas.length, totalAdeudado: t.total, totalVencido: t.vencido })
  return { nombre: `por-pagar-${informe.fecha}.csv`, contenido: generarCsv(cabecera, filas), filas: informe.filas.length }
}

/** Estado de cuenta de un proveedor en CSV: sus cuentas y sus pagos. */
export async function exportarEstadoDeCuentaProveedorCsv(db: TenantPrismaClient, ctx: TenantContext, input: EstadoCuentaProveedorInput): Promise<ArchivoCsv> {
  const e = await estadoDeCuentaProveedor(db, ctx, input)
  const cabecera = ['Tipo', 'Fecha', 'Compra / método', 'Documento / referencia', 'Monto', 'Pagado', 'Saldo', 'Vence', 'Estado', 'Días de mora', 'Pagado por', 'Motivo de anulación']
  const filas = [
    ...e.cuentas.map((c) => ['Compra a crédito', c.fecha, c.compra, c.documento ?? '', { monto: c.monto }, { monto: c.pagado }, { monto: c.saldo }, c.vence, c.estado, c.diasMora, '', '']),
    ...e.pagos.map((a) => ['Pago', a.fecha, a.metodo, a.referencia ?? '', { monto: a.monto }, '', '', '', a.anulado ? 'ANULADO' : 'VIGENTE', '', a.pagadoPor, a.motivoAnulacion ?? '']),
  ]
  filas.push(['DEUDA ACTUAL', e.fecha, '', '', '', '', { monto: e.deudaActual }, '', '', '', '', ''] as never)
  await auditarDescarga(db, ctx, 'estado_cuenta_proveedor.exportado', e.proveedor.id, { filas: e.cuentas.length + e.pagos.length, desde: e.desde, hasta: e.hasta })
  const slug = (e.proveedor.ruc ?? e.proveedor.id).replace(/[^A-Za-z0-9]/g, '')
  return { nombre: `estado-de-cuenta-proveedor-${slug}-${e.fecha}.csv`, contenido: generarCsv(cabecera, filas), filas: filas.length - 1 }
}

// ─── Resumen para el panel ──────────────────────────────────────────────────────────────────────────────────────────

export interface ResumenPorPagar {
  total: number
  vencido: number
  vigente: number
  proveedoresConDeuda: number
  proveedoresVencidos: number
  /** Hasta tres proveedores con más deuda vencida. */
  masUrgentes: { supplierId: string; nombre: string; vencido: number; masAtrasada: number }[]
  coherente: boolean
}

/** La tarjeta «Por pagar» del panel. Sale del mismo informe que la pantalla, así que no pueden discrepar. */
export async function resumenPorPagar(db: TenantPrismaClient, ctx: TenantContext): Promise<ResumenPorPagar> {
  const i = await informeDePorPagar(db, ctx)
  return {
    total: i.totales.total, vencido: i.totales.vencido, vigente: i.totales.vigente,
    proveedoresConDeuda: i.proveedoresConDeuda, proveedoresVencidos: i.proveedoresVencidos,
    masUrgentes: i.filas.filter((f) => f.vencido > 0).slice(0, 3).map((f) => ({ supplierId: f.supplierId, nombre: f.nombre, vencido: f.vencido, masAtrasada: f.masAtrasada })),
    coherente: i.coherente,
  }
}

// ─── Pagos de un proveedor ──────────────────────────────────────────────────────────────────────────────────────────

export interface PagoDeProveedor {
  id: string
  /** AAAA-MM-DD en la zona del negocio. */
  fecha: string
  metodo: string
  monto: number
  referencia: string | null
  pagadoPor: string
  anulado: boolean
  motivoAnulacion: string | null
  /** El pago salió del cajón y su turno sigue abierto: se puede anular. Con el turno cerrado, ya no. */
  anulable: boolean
}

/**
 * Los últimos pagos hechos a un proveedor, para su ficha: de quién, cuánto, con qué y si se anuló. Quién ve las cuentas por pagar los
 * ve; anular es de `proveedores.pagar` y lo decide el servicio. `anulable` adelanta la regla del turno cerrado para no ofrecer un botón
 * que el servidor va a rechazar.
 */
export async function ultimosPagosDeProveedor(db: TenantPrismaClient, ctx: TenantContext, supplierId: string, limite = 10): Promise<PagoDeProveedor[]> {
  exigirVer(ctx)
  const tenant = await db.tenant.findFirstOrThrow({ select: { timezone: true } })
  const pagos = await db.supplierPayment.findMany({
    where: { supplierId }, orderBy: [{ paidAt: 'desc' }, { id: 'desc' }], take: Math.min(Math.max(limite, 1), 50),
    select: {
      id: true, paidAt: true, method: true, amount: true, reference: true, voidedAt: true, voidReason: true,
      user: { select: { name: true } }, cashSession: { select: { status: true } },
    },
  })
  return pagos.map((p) => ({
    id: p.id, fecha: diaLocal(tenant.timezone, p.paidAt), metodo: p.method, monto: num(p.amount), referencia: p.reference, pagadoPor: p.user.name,
    anulado: p.voidedAt !== null, motivoAnulacion: p.voidReason, anulable: p.voidedAt === null && (p.cashSession === null || p.cashSession.status === 'ABIERTA'),
  }))
}
