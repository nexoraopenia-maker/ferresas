import { z } from 'zod'
import { tieneMaxDecimales } from '@/lib/dinero'

const id = z.string().trim().min(1).max(64)
/** Un texto opcional: vacío o solo espacios cuenta como «sin dato». */
const opcional = (max: number) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().max(max).optional())

/**
 * Una línea de compra. La cantidad y el costo van en la unidad de COMPRA: si se compró por caja, «3 cajas a S/ 60.00 la caja».
 * El servidor convierte a unidad base con la presentación guardada y calcula el total; el cliente no manda cantidades base.
 * El costo es SIN IGV (valor de compra).
 */
export const lineaCompraSchema = z.object({
  productId: id,
  variantId: id.nullish(),
  presentationId: id.nullish(),
  /** Cuántas unidades de compra (cajas, sacos…; o unidades base si no hay presentación). */
  enteredQuantity: z.union([z.string().trim().min(1).max(30), z.number().finite()]),
  /** Costo por unidad de compra, SIN IGV. */
  unitCost: z.number().finite().min(0, 'El costo no puede ser negativo.').max(99_999_999, 'El costo está fuera de rango.')
    .refine((n) => tieneMaxDecimales(n, 4), 'Máximo 4 decimales.'),
})
export type LineaCompraInput = z.infer<typeof lineaCompraSchema>

const cabecera = {
  warehouseId: id,
  supplierId: id.nullish(),
  /** N.º del documento del proveedor (factura, boleta o guía). Único por proveedor. */
  invoiceRef: opcional(40),
  paymentCondition: z.enum(['CONTADO', 'CREDITO']).default('CONTADO'),
  /** AAAA-MM-DD. Solo a crédito; si falta, se usa hoy + el plazo del proveedor. */
  vence: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha va como AAAA-MM-DD.').optional()),
  notes: opcional(500),
  items: z.array(lineaCompraSchema).min(1, 'Agrega al menos un producto.').max(200),
}

export const crearBorradorSchema = z.object({ ...cabecera, idempotencyKey: z.uuid('Clave de idempotencia inválida.') })
export type CrearBorradorInput = z.infer<typeof crearBorradorSchema>

export const editarBorradorSchema = z.object({ purchaseId: id, ...cabecera })
export type EditarBorradorInput = z.infer<typeof editarBorradorSchema>

export const recibirCompraSchema = z.object({ purchaseId: id })
export type RecibirCompraInput = z.infer<typeof recibirCompraSchema>

export const anularCompraSchema = z.object({ purchaseId: id, motivo: z.string().trim().min(3, 'Explica el motivo.').max(300) })
export type AnularCompraInput = z.infer<typeof anularCompraSchema>

export const ESTADOS_COMPRA = ['BORRADOR', 'RECIBIDA', 'ANULADA'] as const
export const listarComprasSchema = z.object({
  estado: z.enum(ESTADOS_COMPRA).optional(),
  supplierId: id.optional(),
  q: opcional(60),
  cursor: id.optional(),
  limite: z.number().int().min(1).max(100).default(50),
})
export type ListarComprasInput = z.infer<typeof listarComprasSchema>

export const verCompraSchema = z.object({ purchaseId: id })
