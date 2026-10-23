import type { CustomerDocType, GuideMotive, UnitType } from '@/generated/prisma/enums'
import { validarRuc } from '@/lib/documentos'
import { BusinessError } from '@/lib/errors'
import { diaLocal } from '@/lib/periodos'
import { puede } from '@/lib/puede'
import { requireBranch, type TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { cargarSucursalOperativa, serieDe } from '@/features/branches/queries'
import { formatFullNumber } from '@/features/invoicing/schemas'
import { claimNextNumber, ensureCounter } from '@/features/pos/sale-service'
import type { EmitirGuiaInput } from './schemas'
import { normalizarLicencia, normalizarPlaca, pendientePorProducto } from './reglas'

/**
 * Guía de Remisión — remitente.
 *
 * Emite la guía y la numera (T001-…), pero NO la transmite: no hay proveedor
 * conectado, así que queda PENDIENTE. Ver `docs/COMPLIANCE.md` §7.
 *
 * ─── INTEGRIDAD ──────────────────────────────────────────────────────────
 *
 *  · Nunca se despacha más de lo vendido (o enviado). El control se hace DENTRO
 *    de la transacción, después de reclamar el número: el contador bloquea su
 *    fila, así que dos guías simultáneas de una misma sucursal no se pisan el
 *    «pendiente». Si el control falla, el número vuelve (la transacción se deshace).
 *  · Una guía anulada no cuenta como despachada, pero conserva su número: la
 *    numeración no admite huecos.
 *  · El emisor y el destinatario se CONGELAN al emitir.
 */

const EPS = 0.0001
const num = (d: unknown) => Number(d)
const redondear4 = (n: number) => Math.round(n * 10_000) / 10_000

/** Estados de una transferencia desde los que ya tiene sentido acompañarla con una guía. */
const TRANSFERENCIA_DESPACHABLE = new Set(['APROBADA', 'EN_TRANSITO', 'RECIBIDA'])

export interface GuiaEmitida {
  id: string
  series: string
  correlativo: number
  fullNumber: string
  status: string
}

interface Origen {
  branchId: string
  /** productId → cantidad total de la venta o de la transferencia. */
  cantidades: Map<string, number>
  /** Texto para los mensajes: «venta V-000012». */
  etiqueta: string
}

async function cargarOrigen(
  db: TenantPrismaClient, ctx: TenantContext, input: { saleId?: string; transferId?: string },
): Promise<Origen | null> {
  if (input.saleId) {
    const sale = await db.sale.findFirst({
      where: { id: input.saleId },
      select: { number: true, branchId: true, status: true, items: { select: { productId: true, quantity: true } } },
    })
    if (!sale) throw new BusinessError('TENANT_MISMATCH', 'La venta no existe.')
    if (sale.status !== 'COMPLETADA') {
      throw new BusinessError('INVALID_DOCUMENT', 'Solo se emite guía de una venta completada.')
    }
    const cantidades = new Map<string, number>()
    for (const i of sale.items) cantidades.set(i.productId, redondear4((cantidades.get(i.productId) ?? 0) + num(i.quantity)))
    return { branchId: sale.branchId, cantidades, etiqueta: `la venta ${sale.number}` }
  }
  if (input.transferId) {
    const tr = await db.branchTransfer.findFirst({
      where: { id: input.transferId },
      select: { number: true, status: true, fromBranchId: true, items: { select: { productId: true, quantitySent: true } } },
    })
    if (!tr) throw new BusinessError('TENANT_MISMATCH', 'La transferencia no existe.')
    if (!TRANSFERENCIA_DESPACHABLE.has(tr.status)) {
      throw new BusinessError('INVALID_DOCUMENT', 'La transferencia todavía no está aprobada: no hay mercadería que acompañar.')
    }
    // La guía la emite quien DESPACHA: la sucursal de origen.
    if (ctx.branchIds !== undefined && !ctx.branchIds.includes(tr.fromBranchId)) {
      throw new BusinessError('FORBIDDEN_ROLE', 'La guía de una transferencia la emite la sucursal que despacha.')
    }
    const cantidades = new Map<string, number>()
    for (const i of tr.items) cantidades.set(i.productId, redondear4((cantidades.get(i.productId) ?? 0) + num(i.quantitySent)))
    return { branchId: tr.fromBranchId, cantidades, etiqueta: `la transferencia ${tr.number}` }
  }
  return null
}

/** Cantidad ya cubierta por guías vigentes (no anuladas) de la misma venta o transferencia. */
async function despachado(
  db: TenantPrismaClient, input: { saleId?: string; transferId?: string },
): Promise<Map<string, number>> {
  const filas = await db.dispatchGuideItem.findMany({
    where: { guide: { voidedAt: null, ...(input.saleId ? { saleId: input.saleId } : { transferId: input.transferId }) } },
    select: { productId: true, quantity: true },
  })
  const m = new Map<string, number>()
  for (const f of filas) m.set(f.productId, redondear4((m.get(f.productId) ?? 0) + num(f.quantity)))
  return m
}

export async function emitirGuia(
  db: TenantPrismaClient, ctx: TenantContext, input: EmitirGuiaInput, ahora: Date = new Date(),
): Promise<GuiaEmitida> {
  if (!puede(ctx, 'guias.emitir')) {
    throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para emitir guías de remisión.')
  }

  const tenant = await db.tenant.findFirstOrThrow({ select: { taxId: true, legalName: true, name: true, timezone: true } })
  const ruc = tenant.taxId ? validarRuc(tenant.taxId) : null
  if (!tenant.taxId || !ruc?.valido) {
    throw new BusinessError('INVALID_DOCUMENT', 'Configura primero el RUC del negocio: una guía lo lleva como remitente.')
  }

  const origen = await cargarOrigen(db, ctx, input)
  const branchId = origen?.branchId ?? requireBranch(ctx)

  // Las fechas son días civiles de Lima, no instantes UTC.
  const emision = diaLocal(tenant.timezone ?? 'America/Lima', ahora)
  // ⚠️ Regla a confirmar con la normativa vigente: el traslado no empieza antes de emitir la guía.
  if (input.transferStartDate < emision) {
    throw new BusinessError('INVALID_DOCUMENT', 'La fecha de inicio del traslado no puede ser anterior a la de emisión.')
  }

  const productos = await db.product.findMany({
    where: { id: { in: input.items.map((i) => i.productId) }, deletedAt: null },
    select: { id: true, name: true, sku: true, unitType: true },
  })
  const porId = new Map(productos.map((p) => [p.id, p]))
  for (const it of input.items) {
    if (!porId.has(it.productId)) throw new BusinessError('TENANT_MISMATCH', 'Uno de los productos no existe.')
  }

  const sucursal = await cargarSucursalOperativa(db, branchId)
  const { series } = serieDe(sucursal, 'GUIA_REMISION')
  await ensureCounter(db, ctx.tenantId, branchId, 'GUIA_REMISION', series, '')

  return db.$transaction(async (tx) => {
    const t = tx as unknown as TenantPrismaClient

    // 1) El número primero: bloquea la fila del contador y serializa a quien emita en esta serie.
    const { correlativo } = await claimNextNumber(t, ctx.tenantId, 'GUIA_REMISION', series)
    const fullNumber = formatFullNumber(series, correlativo)

    // 2) Con el bloqueo tomado, el «pendiente» ya no puede cambiar bajo nuestros pies.
    if (origen) {
      const pendiente = pendientePorProducto(origen.cantidades, await despachado(t, input))
      for (const it of input.items) {
        const falta = pendiente.get(it.productId)
        const nombre = porId.get(it.productId)!.name
        if (falta === undefined) {
          throw new BusinessError('INVALID_DOCUMENT', `«${nombre}» no forma parte de ${origen.etiqueta}.`)
        }
        if (it.quantity > falta + EPS) {
          throw new BusinessError('INVALID_DOCUMENT',
            falta <= 0
              ? `«${nombre}» ya está despachado por completo en ${origen.etiqueta}.`
              : `De «${nombre}» solo quedan ${falta} por despachar de ${origen.etiqueta}.`,
            { producto: nombre, pendiente: falta })
        }
      }
    }

    const guia = await t.dispatchGuide.create({
      data: {
        tenantId: ctx.tenantId,
        branchId,
        saleId: input.saleId ?? null,
        transferId: input.transferId ?? null,
        series,
        correlativo,
        fullNumber,
        motive: input.motive as GuideMotive,
        motiveDetail: input.motive === 'OTROS' ? input.motiveDetail ?? null : null,
        transportMode: input.transportMode,
        issueDate: new Date(`${emision}T00:00:00Z`),
        transferStartDate: new Date(`${input.transferStartDate}T00:00:00Z`),
        // El esquema (superRefine) ya garantizó que existe y es positivo.
        grossWeightKg: input.grossWeightKg!,
        packages: input.packages ?? null,
        issuerTaxId: tenant.taxId!,
        issuerLegalName: tenant.legalName ?? tenant.name,
        recipientDocType: input.recipient.docType as CustomerDocType,
        recipientDocNumber: input.recipient.docNumber.trim(),
        recipientName: input.recipient.name,
        originAddress: input.origin.address,
        originUbigeo: input.origin.ubigeo,
        destinationAddress: input.destination.address,
        destinationUbigeo: input.destination.ubigeo,
        ...(input.transportMode === 'PUBLICO'
          ? { carrierRuc: input.carrier!.ruc, carrierName: input.carrier!.name }
          : {
              vehiclePlate: normalizarPlaca(input.vehicle!.plate),
              driverDocType: input.driver!.docType as CustomerDocType,
              driverDocNumber: input.driver!.docNumber.trim(),
              driverName: input.driver!.name,
              driverLicense: normalizarLicencia(input.driver!.license),
            }),
        notes: input.notes || null,
        status: 'PENDIENTE',
        statusMessage: 'Emitida localmente. Aún no se transmite a SUNAT: falta conectar un proveedor.',
        createdById: ctx.userId, // el operador que realmente la emite (con PIN, no el dueño de la sesión)
      },
      select: { id: true, series: true, correlativo: true, fullNumber: true, status: true },
    })

    await t.dispatchGuideItem.createMany({
      data: input.items.map((it) => {
        const p = porId.get(it.productId)!
        return {
          tenantId: ctx.tenantId, guideId: guia.id, productId: p.id,
          nameSnapshot: p.name, skuSnapshot: p.sku, unitType: p.unitType as UnitType, quantity: it.quantity,
        }
      }),
    })

    await t.auditLog.create({
      data: {
        tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role,
        action: 'guia.emitir', entityType: 'DispatchGuide', entityId: guia.id,
        after: {
          guia: fullNumber, motivo: input.motive, modalidad: input.transportMode,
          venta: input.saleId ?? null, transferencia: input.transferId ?? null, lineas: input.items.length,
        },
        impersonationId: ctx.impersonationId ?? null,
      },
    })

    return guia
  }, { maxWait: 15_000, timeout: 30_000 })
}

export async function anularGuia(
  db: TenantPrismaClient, ctx: TenantContext, input: { guideId: string; reason: string }, ahora: Date = new Date(),
): Promise<void> {
  if (!puede(ctx, 'guias.anular')) {
    throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para anular guías de remisión.')
  }
  const g = await db.dispatchGuide.findFirst({
    where: { id: input.guideId }, select: { id: true, fullNumber: true, status: true, voidedAt: true },
  })
  if (!g) throw new BusinessError('TENANT_MISMATCH', 'La guía no existe.')
  if (g.voidedAt) throw new BusinessError('INVALID_DOCUMENT', 'Esa guía ya está anulada.')
  // Una guía que ya salió hacia SUNAT no se «borra» aquí: se da de baja por el canal del proveedor.
  if (g.status !== 'PENDIENTE') {
    throw new BusinessError('INVALID_DOCUMENT', 'Esa guía ya se transmitió: hay que darla de baja desde el proveedor o el portal de SUNAT.')
  }

  // Atómico: dos anulaciones a la vez no la anulan dos veces ni auditan dos veces.
  const r = await db.dispatchGuide.updateMany({
    where: { id: g.id, voidedAt: null },
    data: { voidedAt: ahora, voidReason: input.reason },
  })
  if (r.count !== 1) throw new BusinessError('INVALID_DOCUMENT', 'Esa guía ya está anulada.')

  await db.auditLog.create({
    data: {
      tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role,
      action: 'guia.anular', entityType: 'DispatchGuide', entityId: g.id, reason: input.reason,
      after: { guia: g.fullNumber }, impersonationId: ctx.impersonationId ?? null,
    },
  })
}

export async function listarGuias(db: TenantPrismaClient, take = 100) {
  return db.dispatchGuide.findMany({
    orderBy: [{ createdAt: 'desc' }],
    take,
    select: {
      id: true, fullNumber: true, motive: true, transportMode: true, issueDate: true, transferStartDate: true,
      recipientName: true, recipientDocNumber: true, destinationAddress: true, grossWeightKg: true,
      status: true, statusMessage: true, voidedAt: true, voidReason: true,
      sale: { select: { number: true } }, transfer: { select: { number: true } },
      _count: { select: { items: true } },
    },
    relationLoadStrategy: 'join',
  })
}

// ─── Borradores: lo que la pantalla precarga ────────────────────────────────

export interface LineaBorrador {
  productId: string
  name: string
  sku: string
  unitType: string
  /** Lo que se propone despachar: todo lo pendiente. */
  quantity: number
  /** Tope: lo pendiente (null si no hay origen que lo limite). */
  max: number | null
}

export interface BorradorGuia {
  saleId?: string
  transferId?: string
  motive: GuideMotive
  /** «Venta V-000012», para el encabezado. */
  etiquetaOrigen: string | null
  recipient: { docType: CustomerDocType | ''; docNumber: string; name: string }
  origin: { address: string; ubigeo: string }
  destination: { address: string; ubigeo: string }
  items: LineaBorrador[]
}

const direccionDe = async (db: TenantPrismaClient, branchId: string) => {
  const b = await db.branch.findFirst({ where: { id: branchId }, select: { address: true, ubigeo: true } })
  return { address: b?.address ?? '', ubigeo: b?.ubigeo ?? '' }
}

async function lineasPendientes(
  db: TenantPrismaClient, origen: Origen, input: { saleId?: string; transferId?: string },
): Promise<LineaBorrador[]> {
  const pendiente = pendientePorProducto(origen.cantidades, await despachado(db, input))
  const ids = [...pendiente].filter(([, falta]) => falta > 0).map(([id]) => id)
  const ps = await db.product.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, sku: true, unitType: true } })
  return ps.map((p) => ({
    productId: p.id, name: p.name, sku: p.sku, unitType: p.unitType,
    quantity: pendiente.get(p.id)!, max: pendiente.get(p.id)!,
  }))
}

export async function borradorDeVenta(db: TenantPrismaClient, ctx: TenantContext, saleId: string): Promise<BorradorGuia> {
  if (!puede(ctx, 'guias.emitir')) throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para emitir guías de remisión.')
  const input = { saleId }
  const origen = (await cargarOrigen(db, ctx, input))!
  const venta = await db.sale.findFirst({
    where: { id: saleId },
    select: { number: true, customer: { select: { docType: true, docNumber: true, name: true, address: true } } },
  })
  const c = venta?.customer
  return {
    saleId, motive: 'VENTA', etiquetaOrigen: `Venta ${venta?.number ?? ''}`.trim(),
    recipient: c && c.docType !== 'SIN_DOCUMENTO' && c.docNumber
      ? { docType: c.docType, docNumber: c.docNumber, name: c.name }
      : { docType: '', docNumber: '', name: c?.name ?? '' },
    origin: await direccionDe(db, origen.branchId),
    destination: { address: c?.address ?? '', ubigeo: '' },
    items: await lineasPendientes(db, origen, input),
  }
}

export async function borradorDeTransferencia(db: TenantPrismaClient, ctx: TenantContext, transferId: string): Promise<BorradorGuia> {
  if (!puede(ctx, 'guias.emitir')) throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para emitir guías de remisión.')
  const input = { transferId }
  const origen = (await cargarOrigen(db, ctx, input))!
  const [tr, tenant] = await Promise.all([
    db.branchTransfer.findFirst({ where: { id: transferId }, select: { number: true, toBranchId: true } }),
    db.tenant.findFirst({ select: { taxId: true, legalName: true, name: true } }),
  ])
  return {
    transferId, motive: 'TRASLADO_ESTABLECIMIENTOS', etiquetaOrigen: `Transferencia ${tr?.number ?? ''}`.trim(),
    // En un traslado entre establecimientos el destinatario es el propio negocio.
    recipient: { docType: tenant?.taxId ? 'RUC' : '', docNumber: tenant?.taxId ?? '', name: tenant?.legalName ?? tenant?.name ?? '' },
    origin: await direccionDe(db, origen.branchId),
    destination: tr ? await direccionDe(db, tr.toBranchId) : { address: '', ubigeo: '' },
    items: await lineasPendientes(db, origen, input),
  }
}
