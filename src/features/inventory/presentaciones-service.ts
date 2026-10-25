import type { UnitType } from '@/generated/prisma/enums'
import { BusinessError } from '@/lib/errors'
import { exigir, puede } from '@/lib/puede'
import type { TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { CodigoDeOtro, limpiarCodigo, tipoDeCodigo } from './codigos'
import { calcularLinea, ConversionInvalida, ESCALA_FACTOR, ESCALA_PRECIO } from './conversion'

/**
 * Presentaciones de un producto («Caja x 12», «Saco 42,5 kg»): alta y baja. Una presentación solo CONVIERTE: el stock sigue
 * siendo del producto, en su unidad base (`conversion.ts`).
 */

export interface EntradaPresentacion {
  productId: string
  name: string
  unitType: UnitType
  /** Unidades base por presentación. */
  factor: string | number
  /** Precio propio; si falta, manda precio base × factor. */
  salePrice?: string | number | null
  costPrice?: string | number | null
  isDefaultSale?: boolean
  /** Código de barras de la presentación (el EAN de la caja no es el de la unidad). */
  code?: string | null
}

const invalida = (m: string) => new BusinessError('INVALID_DOCUMENT', m)

/** Valida la presentación contra la unidad base del producto (p. ej. un producto en UNIDAD no admite factor 0.5). */
export function validarPresentacion(e: Pick<EntradaPresentacion, 'name' | 'unitType' | 'factor' | 'salePrice' | 'costPrice'>, unidadBase: UnitType): { name: string } {
  const name = e.name.trim()
  if (name.length < 1 || name.length > 80) throw invalida('El nombre de la presentación debe tener entre 1 y 80 caracteres.')
  try {
    // Una presentación: 1 × factor. Cubre factor positivo, escala, y que lo que contiene respete la unidad base.
    calcularLinea({ precioPresentacion: 0, cantidadIngresada: 1, factor: e.factor, unidadPresentacion: e.unitType, unidadBase })
    for (const [precio, que] of [[e.salePrice, 'de venta'], [e.costPrice, 'de costo']] as const) {
      if (precio !== null && precio !== undefined) {
        calcularLinea({ precioPresentacion: precio, cantidadIngresada: 1, factor: e.factor, unidadPresentacion: e.unitType, unidadBase })
        if (String(precio).includes('.') && String(precio).split('.')[1]!.length > ESCALA_PRECIO) throw invalida(`El precio ${que} admite hasta ${ESCALA_PRECIO} decimales.`)
      }
    }
  } catch (err) {
    if (err instanceof ConversionInvalida) {
      throw invalida(err.codigo === 'FACTOR' ? `Factor inválido: ${err.message} (hasta ${ESCALA_FACTOR} decimales)` : err.message)
    }
    throw err
  }
  return { name }
}

export async function crearPresentacion(db: TenantPrismaClient, ctx: TenantContext, input: EntradaPresentacion): Promise<{ id: string }> {
  exigir(ctx, 'productos.crear')
  const producto = await db.product.findFirst({ where: { id: input.productId, deletedAt: null }, select: { id: true, unitType: true } })
  if (!producto) throw new BusinessError('NOT_FOUND', 'El producto no existe.')
  // Igual que al crear un producto: registrar un COSTO exige poder verlo (quien no, no puede ni fijarlo).
  if (input.costPrice != null && !puede(ctx, 'productos.ver_costo')) {
    throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para registrar costos.')
  }
  const { name } = validarPresentacion(input, producto.unitType)
  const code = limpiarCodigo(input.code)

  return db.$transaction(async (tx) => {
    const t = tx as unknown as TenantPrismaClient
    const repetida = await t.productPresentation.findFirst({ where: { productId: producto.id, name }, select: { id: true } })
    if (repetida) throw new BusinessError('DUPLICATE_CODE', `El producto ya tiene una presentación llamada «${name}».`)

    if (input.isDefaultSale) {
      // Una sola de venta por defecto: se baja la anterior antes de subir la nueva (índice único parcial).
      await t.productPresentation.updateMany({ where: { productId: producto.id, isDefaultSale: true }, data: { isDefaultSale: false } })
    }
    const p = await t.productPresentation.create({
      data: {
        tenantId: ctx.tenantId, productId: producto.id, name, unitType: input.unitType,
        factor: String(input.factor), salePrice: input.salePrice == null ? null : String(input.salePrice),
        costPrice: input.costPrice == null ? null : String(input.costPrice), isDefaultSale: !!input.isDefaultSale,
      },
      select: { id: true },
    })
    if (code) {
      const otro = await t.productCode.findFirst({ where: { code }, select: { id: true } })
      if (otro) throw new CodigoDeOtro(code)
      const yaTiene = await t.productCode.count({ where: { productId: producto.id, variantId: null, presentationId: p.id } })
      await t.productCode.create({ data: { tenantId: ctx.tenantId, productId: producto.id, presentationId: p.id, code, type: tipoDeCodigo(code), isPrimary: yaTiene === 0 } })
    }
    await t.auditLog.create({
      data: {
        tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role, action: 'presentacion.crear', entityType: 'ProductPresentation', entityId: p.id,
        after: { producto: producto.id, nombre: name, unidad: input.unitType, factor: String(input.factor), codigo: code }, impersonationId: ctx.impersonationId ?? null,
      },
    })
    return p
  })
}

/** Baja lógica: deja de venderse y su código deja de resolver. Las líneas ya emitidas conservan su copia (nombre y factor). */
export async function desactivarPresentacion(db: TenantPrismaClient, ctx: TenantContext, presentationId: string, ahora: Date = new Date()): Promise<void> {
  exigir(ctx, 'productos.crear')
  const r = await db.productPresentation.updateMany({ where: { id: presentationId, deletedAt: null }, data: { isActive: false, isDefaultSale: false, deletedAt: ahora } })
  if (r.count !== 1) throw new BusinessError('NOT_FOUND', 'La presentación no existe.')
  await db.auditLog.create({ data: { tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role, action: 'presentacion.desactivar', entityType: 'ProductPresentation', entityId: presentationId, impersonationId: ctx.impersonationId ?? null } })
}
