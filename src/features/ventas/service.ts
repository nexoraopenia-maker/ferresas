import { BusinessError } from '@/lib/errors'
import type { TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { describirPeriodo, resolverPeriodo, type PeriodoElegido } from '@/features/reportes/periodo'
import { puedeVerVentas } from './permisos'
import { TAMANO_PAGINA_VENTAS, type EstadoVenta, type ParametrosVentasLista } from './schemas'

/**
 * Historial de ventas y detalle de una venta. SOLO LECTURA.
 *
 *  · Lo ve quien cobra, quien anula o quien revisa reportes (`puedeVerVentas`); anular o devolver es aparte (`ventas.anular`).
 *  · NUNCA lee ni devuelve el costo, la utilidad ni el margen: ningún `select` de este archivo nombra `unitCost` ni `costPrice`
 *    (lo vigila `tests/ventas-servicio.ts` y la lista blanca de `tests/costo.ts`).
 *  · Ventas y comprobantes se acotan solos por negocio y por sucursal (el cliente aislado); aquí solo se añaden los filtros.
 */
const num = (d: { toString(): string } | null | undefined) => Number(d?.toString() ?? 0)
const exigirVer = (ctx: TenantContext) => {
  if (!puedeVerVentas(ctx)) throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para ver las ventas.')
}
const ESTADOS: EstadoVenta[] = ['COMPLETADA', 'ANULADA', 'DEVUELTA']
const PRINCIPALES = ['BOLETA', 'FACTURA'] as const

export interface FilaVenta {
  id: string
  numero: string
  /** ISO del cobro. */
  cuando: string
  sucursal: string
  cliente: string | null
  total: number
  estado: EstadoVenta
  cobro: string
  comprobante: { numero: string; estado: string; esEnsayo: boolean } | null
}

export interface PaginaVentas { filas: FilaVenta[]; siguiente: string | null; textoPeriodo: string | null; zona: string; sucursales: { id: string; nombre: string }[] }

export async function listarVentas(db: TenantPrismaClient, ctx: TenantContext, p: ParametrosVentasLista, ahora: Date = new Date()): Promise<PaginaVentas> {
  exigirVer(ctx)
  const t = await db.tenant.findFirstOrThrow({ select: { timezone: true } })
  // Buscar por número, cliente o comprobante ignora el periodo: la venta que buscas puede ser de hace meses.
  let periodo: PeriodoElegido | null = null
  if (!p.q) {
    try { periodo = resolverPeriodo({ preset: p.p, desde: p.desde, hasta: p.hasta }, ahora, t.timezone) } catch (e) {
      if (e instanceof RangeError) throw new BusinessError('INVALID_DOCUMENT', e.message)
      throw e
    }
  }
  const y: object[] = [{ status: { in: p.estado ? [p.estado] : ESTADOS } }]
  if (periodo) y.push({ completedAt: { gte: periodo.desde, lt: periodo.hasta } })
  if (p.sucursal) y.push({ branchId: p.sucursal })
  if (p.comprobante === 'SIN') y.push({ taxDocuments: { none: { documentType: { in: [...PRINCIPALES] } } } })
  else if (p.comprobante) y.push({ taxDocuments: { some: { documentType: p.comprobante } } })
  if (p.q) {
    y.push({
      OR: [
        { number: { contains: p.q, mode: 'insensitive' } },
        { taxDocuments: { some: { fullNumber: { contains: p.q, mode: 'insensitive' } } } },
        { customer: { name: { contains: p.q, mode: 'insensitive' } } },
        { customer: { docNumber: { contains: p.q } } },
      ],
    })
  }
  if (p.cursor) {
    const [iso, id] = p.cursor.split('|') as [string, string]
    const c = new Date(iso)
    y.push({ OR: [{ completedAt: { lt: c } }, { completedAt: c, id: { lt: id } }] })
  }
  const [filas, sucursales] = await Promise.all([
    db.sale.findMany({
      where: { AND: y },
      orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
      take: TAMANO_PAGINA_VENTAS + 1,
      select: {
        id: true, number: true, status: true, total: true, completedAt: true,
        branch: { select: { name: true } }, customer: { select: { name: true } }, user: { select: { name: true, email: true } },
        taxDocuments: { where: { documentType: { in: [...PRINCIPALES] } }, take: 1, select: { fullNumber: true, status: true, isTrial: true } },
      },
    }),
    db.branch.findMany({ where: { deletedAt: null, ...(ctx.branchIds ? { id: { in: [...ctx.branchIds] } } : {}) }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
  ])
  const hayMas = filas.length > TAMANO_PAGINA_VENTAS
  const visibles = filas.slice(0, TAMANO_PAGINA_VENTAS)
  const ultima = visibles[visibles.length - 1]
  return {
    textoPeriodo: periodo ? describirPeriodo(periodo) : null, zona: t.timezone, sucursales: sucursales.map((s) => ({ id: s.id, nombre: s.name })),
    siguiente: hayMas && ultima?.completedAt ? `${ultima.completedAt.toISOString()}|${ultima.id}` : null,
    filas: visibles.map((v): FilaVenta => {
      const d = v.taxDocuments[0]
      return {
        id: v.id, numero: v.number, cuando: (v.completedAt ?? new Date(0)).toISOString(), sucursal: v.branch.name, cliente: v.customer?.name ?? null, total: num(v.total),
        estado: v.status as EstadoVenta, cobro: v.user.name || v.user.email, comprobante: d ? { numero: d.fullNumber, estado: d.status, esEnsayo: d.isTrial } : null,
      }
    }),
  }
}

// ─── Detalle ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface LineaVenta { nombre: string; sku: string; unidad: string; cantidad: number; presentacion: { nombre: string; ingresada: number; factor: number } | null; precio: number; descuento: number; total: number }
export interface PagoVenta { metodo: string; monto: number; vuelto: number; referencia: string | null }
export interface ComprobanteVenta { id: string; tipo: string; numero: string; estado: string; esEnsayo: boolean; emitidoEn: string; relacionado: string | null; anuladoEn: string | null }
export interface DevolucionVenta {
  id: string
  numero: string
  tipo: 'ANULACION' | 'DEVOLUCION'
  cuando: string
  autorizo: string
  motivo: string
  pagadoNeto: number
  deudaCancelada: number
  notaDeCredito: string | null
  /** Turno de caja del que salió el efectivo (apertura), si salió. */
  turno: { id: string; abiertoEn: string } | null
  reembolsos: { modo: 'CAJA' | 'EXTERNO' | 'SIN_SALIDA'; medio: string | null; monto: number; referencia: string | null }[]
  lineas: number
}

export interface DetalleVenta {
  id: string
  numero: string
  estado: EstadoVenta | 'BORRADOR'
  cuando: string | null
  sucursal: { id: string; nombre: string }
  cobro: string
  cliente: { nombre: string; documento: string | null } | null
  notas: string | null
  subtotal: number
  igv: number
  descuento: number
  total: number
  lineas: LineaVenta[]
  pagos: PagoVenta[]
  cuenta: { estado: string; monto: number; abonado: number; saldo: number; vence: string; enRevision: boolean } | null
  comprobantes: ComprobanteVenta[]
  guias: string[]
  devoluciones: DevolucionVenta[]
  zona: string
}

export async function obtenerVenta(db: TenantPrismaClient, ctx: TenantContext, saleId: string): Promise<DetalleVenta> {
  exigirVer(ctx)
  const v = await db.sale.findFirst({
    where: { id: saleId },
    select: {
      id: true, number: true, status: true, completedAt: true, subtotal: true, taxTotal: true, discountTotal: true, total: true, notes: true,
      branch: { select: { id: true, name: true } }, user: { select: { name: true, email: true } }, customer: { select: { name: true, docType: true, docNumber: true } },
      items: {
        orderBy: { id: 'asc' },
        select: { nameSnapshot: true, skuSnapshot: true, unitType: true, quantity: true, unitPrice: true, discount: true, lineTotal: true, enteredQuantity: true, presentationName: true, presentationFactor: true },
      },
      payments: { orderBy: { createdAt: 'asc' }, select: { method: true, amount: true, change: true, reference: true } },
      receivable: { select: { status: true, amount: true, paidAmount: true, dueDate: true, reviewRequestedAt: true } },
      taxDocuments: {
        orderBy: { issuedAt: 'asc' },
        select: { id: true, documentType: true, fullNumber: true, status: true, isTrial: true, issuedAt: true, voidedAt: true, relatedDocument: { select: { fullNumber: true } } },
      },
      dispatchGuides: { select: { fullNumber: true } },
      saleReturns: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true, number: true, kind: true, createdAt: true, reason: true, paidNet: true, receivableVoidedAmount: true,
          user: { select: { name: true, email: true } }, creditNote: { select: { fullNumber: true } },
          refunds: { select: { mode: true, method: true, amount: true, reference: true, cashSession: { select: { id: true, openedAt: true } } } },
          _count: { select: { items: true } },
        },
      },
    },
  })
  if (!v) throw new BusinessError('NOT_FOUND', 'La venta no existe.')
  const t = await db.tenant.findFirstOrThrow({ select: { timezone: true } })
  const saldo = v.receivable ? Math.round((num(v.receivable.amount) - num(v.receivable.paidAmount)) * 100) / 100 : 0
  return {
    id: v.id, numero: v.number, estado: v.status as DetalleVenta['estado'], cuando: v.completedAt ? v.completedAt.toISOString() : null,
    sucursal: { id: v.branch.id, nombre: v.branch.name }, cobro: v.user.name || v.user.email,
    cliente: v.customer ? { nombre: v.customer.name, documento: v.customer.docNumber ? `${v.customer.docType} ${v.customer.docNumber}` : null } : null,
    notas: v.notes, subtotal: num(v.subtotal), igv: num(v.taxTotal), descuento: num(v.discountTotal), total: num(v.total),
    lineas: v.items.map((i) => ({
      nombre: i.nameSnapshot, sku: i.skuSnapshot, unidad: i.unitType, cantidad: num(i.quantity), precio: num(i.unitPrice), descuento: num(i.discount), total: num(i.lineTotal),
      presentacion: i.presentationName && i.enteredQuantity !== null && i.presentationFactor !== null ? { nombre: i.presentationName, ingresada: num(i.enteredQuantity), factor: num(i.presentationFactor) } : null,
    })),
    pagos: v.payments.map((p) => ({ metodo: p.method, monto: num(p.amount), vuelto: num(p.change), referencia: p.reference })),
    cuenta: v.receivable ? { estado: v.receivable.status, monto: num(v.receivable.amount), abonado: num(v.receivable.paidAmount), saldo, vence: v.receivable.dueDate.toISOString().slice(0, 10), enRevision: v.receivable.reviewRequestedAt !== null } : null,
    comprobantes: v.taxDocuments.map((d) => ({ id: d.id, tipo: d.documentType, numero: d.fullNumber, estado: d.status, esEnsayo: d.isTrial, emitidoEn: d.issuedAt.toISOString(), relacionado: d.relatedDocument?.fullNumber ?? null, anuladoEn: d.voidedAt ? d.voidedAt.toISOString() : null })),
    guias: v.dispatchGuides.map((g) => g.fullNumber),
    devoluciones: v.saleReturns.map((r): DevolucionVenta => {
      const caja = r.refunds.find((x) => x.cashSession)?.cashSession ?? null
      return {
        id: r.id, numero: r.number, tipo: r.kind, cuando: r.createdAt.toISOString(), autorizo: r.user.name || r.user.email, motivo: r.reason, pagadoNeto: num(r.paidNet),
        deudaCancelada: num(r.receivableVoidedAmount), notaDeCredito: r.creditNote?.fullNumber ?? null, lineas: r._count.items,
        turno: caja ? { id: caja.id, abiertoEn: caja.openedAt.toISOString() } : null,
        reembolsos: r.refunds.map((x) => ({ modo: x.mode, medio: x.method, monto: num(x.amount), referencia: x.reference })),
      }
    }),
    zona: t.timezone,
  }
}
