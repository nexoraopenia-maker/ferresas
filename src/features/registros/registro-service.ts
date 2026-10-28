import { BusinessError } from '@/lib/errors'
import { generarCsv } from '@/lib/csv-export'
import { diaLocal } from '@/lib/periodos'
import { exigir } from '@/lib/puede'
import type { TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { describirPeriodo, resolverPeriodo, sumarDiasDia, type PeriodoElegido } from '@/features/reportes/periodo'
import type { ArchivoCsv } from '@/features/reportes/ventas-service'
import type { TipoDocumentoCompra } from '@/features/compras/documento'
import { registroCompras, registroVentas, type CompraRegistrable, type ComprobanteVenta, type RegistroCompras, type RegistroVentas, type TipoComprobante } from './registro-calculo'
import { csvRegistroCompras, csvRegistroVentas } from './registro-csv'
import type { ParametrosRegistros, TipoRegistro } from './schemas'

/**
 * Registros de ventas y de compras. SOLO LECTURA (salvo la línea de auditoría de cada descarga). Los pide `reportes.ver`: dueño, administrador
 * y contador. Los de compras muestran el total de cada DOCUMENTO, nunca el costo de cada producto (eso sigue siendo del permiso de ver costos).
 *
 * Sucursales: los comprobantes se acotan solos (por su venta); las compras NO (son del negocio, su almacén es de una sucursal), así que se
 * acotan aquí a mano por las sucursales del usuario.
 */
const LOTE = 1000
const num = (d: { toString(): string } | null | undefined) => Number(d?.toString() ?? 0)
const exigirRegistros = (ctx: TenantContext) => exigir(ctx, 'reportes.ver')

export interface InformeRegistro<T> { periodo: PeriodoElegido; textoPeriodo: string; zona: string; datos: T }

async function preparar(db: TenantPrismaClient, ctx: TenantContext, p: ParametrosRegistros, ahora: Date) {
  exigirRegistros(ctx)
  const t = await db.tenant.findFirstOrThrow({ select: { timezone: true } })
  try {
    return { zona: t.timezone, periodo: resolverPeriodo({ preset: p.p, desde: p.desde, hasta: p.hasta }, ahora, t.timezone) }
  } catch (e) {
    if (e instanceof RangeError) throw new BusinessError('INVALID_DOCUMENT', e.message)
    throw e
  }
}

/** Lee los comprobantes del periodo (sin comprobar permisos: lo hace quien llama). Lo comparten el registro y la conciliación fiscal. */
export async function leerComprobantes(db: TenantPrismaClient, zona: string, periodo: Pick<PeriodoElegido, 'desde' | 'hasta'>): Promise<ComprobanteVenta[]> {
  const docs: ComprobanteVenta[] = []
  let cursor: string | undefined
  for (;;) {
    const lote = await db.taxDocument.findMany({
      where: { isTrial: false, documentType: { in: ['FACTURA', 'BOLETA', 'NOTA_CREDITO', 'NOTA_DEBITO'] }, issuedAt: { gte: periodo.desde, lt: periodo.hasta } },
      orderBy: { id: 'asc' }, take: LOTE, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true, issuedAt: true, documentType: true, fullNumber: true, receiverDocType: true, receiverDocNumber: true, receiverName: true, currency: true,
        subtotal: true, taxTotal: true, total: true, status: true, relatedDocument: { select: { fullNumber: true } },
      },
    })
    for (const d of lote) {
      docs.push({
        id: d.id, fecha: diaLocal(zona, d.issuedAt), tipo: d.documentType as TipoComprobante, numero: d.fullNumber, relacionado: d.relatedDocument?.fullNumber ?? null,
        receptorTipo: d.receiverDocType, receptorNumero: d.receiverDocNumber, receptorNombre: d.receiverName, moneda: d.currency,
        base: num(d.subtotal), igv: num(d.taxTotal), total: num(d.total), estado: d.status,
      })
    }
    if (lote.length < LOTE) break
    cursor = lote[lote.length - 1]!.id
  }
  return docs
}

/** El predicado de «compras del periodo»: con documento manda su emisión (un día); sin él, la recepción (provisional). */
export function filtroComprasDelPeriodo(periodo: PeriodoElegido, branchIds?: readonly string[]) {
  const desdeDia = new Date(`${periodo.desdeDia}T00:00:00.000Z`), hastaDia = new Date(`${sumarDiasDia(periodo.hastaDia, 1)}T00:00:00.000Z`)
  return {
    status: 'RECIBIDA' as const,
    OR: [{ issueDate: { gte: desdeDia, lt: hastaDia } }, { issueDate: null, receivedAt: { gte: periodo.desde, lt: periodo.hasta } }],
    ...(branchIds ? { warehouse: { branchId: { in: [...branchIds] } } } : {}),
  }
}

/** Lee las compras del periodo (sin comprobar permisos). Se acota por las sucursales dadas: las compras no se acotan solas. */
export async function leerCompras(db: TenantPrismaClient, zona: string, periodo: PeriodoElegido, branchIds?: readonly string[]): Promise<CompraRegistrable[]> {
  const compras: CompraRegistrable[] = []
  let cursor: string | undefined
  for (;;) {
    const lote = await db.purchase.findMany({
      where: filtroComprasDelPeriodo(periodo, branchIds),
      orderBy: { id: 'asc' }, take: LOTE, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true, number: true, issueDate: true, receivedAt: true, createdAt: true, docType: true, docSeries: true, docNumber: true, invoiceRef: true, paymentCondition: true,
        subtotal: true, taxTotal: true, total: true, supplier: { select: { name: true, taxId: true } },
      },
    })
    for (const k of lote) {
      compras.push({
        id: k.id, compra: k.number, emision: k.issueDate ? k.issueDate.toISOString().slice(0, 10) : null, recepcion: diaLocal(zona, k.receivedAt ?? k.createdAt),
        tipo: (k.docType as TipoDocumentoCompra | null) ?? null, serie: k.docSeries, numero: k.docNumber, referencia: k.invoiceRef,
        proveedorRuc: k.supplier?.taxId ?? null, proveedorNombre: k.supplier?.name ?? null,
        base: num(k.subtotal), igv: num(k.taxTotal), total: num(k.total), condicion: k.paymentCondition,
      })
    }
    if (lote.length < LOTE) break
    cursor = lote[lote.length - 1]!.id
  }
  return compras
}

export async function informeRegistroVentas(db: TenantPrismaClient, ctx: TenantContext, p: ParametrosRegistros, ahora: Date = new Date()): Promise<InformeRegistro<RegistroVentas>> {
  const { zona, periodo } = await preparar(db, ctx, p, ahora)
  return { periodo, zona, textoPeriodo: describirPeriodo(periodo), datos: registroVentas(await leerComprobantes(db, zona, periodo)) }
}

export async function informeRegistroCompras(db: TenantPrismaClient, ctx: TenantContext, p: ParametrosRegistros, ahora: Date = new Date()): Promise<InformeRegistro<RegistroCompras>> {
  const { zona, periodo } = await preparar(db, ctx, p, ahora)
  return { periodo, zona, textoPeriodo: describirPeriodo(periodo), datos: registroCompras(await leerCompras(db, zona, periodo, ctx.branchIds)) }
}

/** Descarga un registro en CSV. Queda en la auditoría quién lo bajó, qué periodo y cuántas filas. */
export async function exportarRegistroCsv(db: TenantPrismaClient, ctx: TenantContext, tipo: TipoRegistro, p: ParametrosRegistros, ahora: Date = new Date()): Promise<ArchivoCsv> {
  const r = tipo === 'ventas' ? await informeRegistroVentas(db, ctx, p, ahora) : await informeRegistroCompras(db, ctx, p, ahora)
  const tabla = tipo === 'ventas' ? csvRegistroVentas(r.datos as RegistroVentas) : csvRegistroCompras(r.datos as RegistroCompras)
  const filas = (r.datos as RegistroVentas | RegistroCompras).filas.length
  await db.auditLog.create({
    data: {
      tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role, action: 'reporte.exportado', entityType: 'Reporte', entityId: `registro-${tipo}`,
      after: { reporte: `registro-${tipo}`, desde: r.periodo.desdeDia, hasta: r.periodo.hastaDia, filas } as never, impersonationId: ctx.impersonationId ?? null,
    },
  })
  return { nombre: `registro-${tipo}-${r.periodo.desdeDia}_${r.periodo.hastaDia}.csv`, contenido: generarCsv(tabla.cabecera, tabla.filas), filas }
}
