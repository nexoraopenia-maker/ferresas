import { z } from 'zod'
import { tieneMaxDecimales } from '@/lib/dinero'

/**
 * Validación de entrada de la toma de inventario físico (F6.5a). Sin `tenantId`: sale de la sesión. Las claves de idempotencia las genera el cliente ANTES de enviar
 * (el móvil reintenta con mala señal y la operación se aplica una sola vez).
 */

/** Tope de líneas de un conteo. Más que esto es un conteo que nadie puede terminar: se pide acotarlo (por categoría o por selección). */
export const MAX_LINEAS_CONTEO = 20_000
/** Una selección explícita de productos es una lista corta que alguien eligió; más de esto es un conteo total o por categoría. */
export const MAX_PRODUCTOS_SELECCION = 2_000
export const LARGO_MAXIMO_ZONA = 40

const id = z.string().trim().min(1, 'Falta el dato.').max(64, 'El identificador es demasiado largo.')
const clave = z.uuid('Clave de idempotencia inválida.')
const motivo = z.string().trim().min(3, 'Explica el motivo (mínimo 3 caracteres).').max(280, 'El motivo es demasiado largo (máximo 280 caracteres).')

/** Cantidades contadas: hasta 4 decimales; cero es una cantidad válida (contar «ninguno» también es contar). */
const cantidadContada = z
  .number({ error: 'Ingresa la cantidad contada.' })
  .finite('La cantidad no es un número válido.')
  .refine((n) => n >= 0, { message: 'La cantidad contada no puede ser negativa.' })
  .refine((n) => n < 1e9, { message: 'La cantidad está fuera de rango.' })
  .refine((n) => tieneMaxDecimales(n, 4), { message: 'Máximo 4 decimales.' })

export const crearConteoSchema = z.object({
  warehouseId: id,
  scope: z.enum(['TOTAL', 'CATEGORIA', 'SELECCION']),
  categoryId: id.optional(),
  /** Solo en la selección: los productos que se van a contar. */
  productIds: z.array(id).min(1, 'Elige al menos un producto.').max(MAX_PRODUCTOS_SELECCION, `Máximo ${MAX_PRODUCTOS_SELECCION} productos por selección.`).optional(),
  mode: z.enum(['CIEGO', 'GUIADO']).default('CIEGO'),
  notes: z.string().trim().max(280, 'La nota es demasiado larga (máximo 280 caracteres).').optional(),
  idempotencyKey: clave,
}).superRefine((v, ctx) => {
  if (v.scope === 'CATEGORIA' && !v.categoryId) ctx.addIssue({ code: 'custom', path: ['categoryId'], message: 'Elige la categoría que se va a contar.' })
  if (v.scope !== 'CATEGORIA' && v.categoryId) ctx.addIssue({ code: 'custom', path: ['categoryId'], message: 'La categoría solo se usa en un conteo por categoría.' })
  if (v.scope === 'SELECCION' && !v.productIds) ctx.addIssue({ code: 'custom', path: ['productIds'], message: 'Elige los productos que se van a contar.' })
  if (v.scope !== 'SELECCION' && v.productIds) ctx.addIssue({ code: 'custom', path: ['productIds'], message: 'Los productos se eligen solo en un conteo por selección.' })
  if (v.productIds && new Set(v.productIds).size !== v.productIds.length) ctx.addIssue({ code: 'custom', path: ['productIds'], message: 'Hay productos repetidos en la selección.' })
})
export type CrearConteoInput = z.infer<typeof crearConteoSchema>

export const iniciarConteoSchema = z.object({ countId: id })
export type IniciarConteoInput = z.infer<typeof iniciarConteoSchema>

export const cerrarConteoSchema = z.object({ countId: id })
export type CerrarConteoInput = z.infer<typeof cerrarConteoSchema>

export const cancelarConteoSchema = z.object({ countId: id, reason: motivo })
export type CancelarConteoInput = z.infer<typeof cancelarConteoSchema>

/**
 * Una pasada: lo que se contó de un producto. `quantity` es SIEMPRE la cantidad en unidad base; si se contó en una presentación (cajas), van juntas
 * `presentationId` y `enteredQuantity` y el servidor recalcula y compara.
 */
export const registrarPasadaSchema = z.object({
  countId: id,
  productId: id,
  variantId: id.nullish(),
  quantity: cantidadContada,
  presentationId: id.nullish(),
  enteredQuantity: z.union([z.string().trim().min(1).max(30), z.number().finite()]).nullish(),
  /** Pasillo, estante… texto libre. Vacío = sin zona. */
  zone: z.string().trim().max(LARGO_MAXIMO_ZONA, `La zona admite hasta ${LARGO_MAXIMO_ZONA} caracteres.`).optional().transform((v) => (v ? v : undefined)),
  idempotencyKey: clave,
}).refine((m) => (m.presentationId == null) === (m.enteredQuantity == null), { message: 'La presentación y la cantidad ingresada van juntas.', path: ['presentationId'] })
export type RegistrarPasadaInput = z.infer<typeof registrarPasadaSchema>

export const anularPasadaSchema = z.object({ entryId: id, reason: motivo })
export type AnularPasadaInput = z.infer<typeof anularPasadaSchema>

// ─── F6.5b: revisión y aplicación ─────────────────────────────────────────────────────────────────────────────────────

export const recontarLineaSchema = z.object({ countId: id, itemId: id, reason: motivo })
export type RecontarLineaInput = z.infer<typeof recontarLineaSchema>

export const aprobarLineaSchema = z.object({
  countId: id,
  itemId: id,
  /** El revisor sabe que la diferencia supera el umbral operativo y la aprueba igual. Sin esto, una diferencia grande se rechaza con `COUNT_OVER_THRESHOLD`. */
  confirmaUmbral: z.boolean().default(false),
  note: z.string().trim().max(280, 'La nota es demasiado larga (máximo 280 caracteres).').optional(),
})
export type AprobarLineaInput = z.infer<typeof aprobarLineaSchema>

export const rechazarLineaSchema = z.object({ countId: id, itemId: id, reason: motivo })
export type RechazarLineaInput = z.infer<typeof rechazarLineaSchema>

export const aprobarSinAlertaSchema = z.object({ countId: id, cursor: id.optional() })
export type AprobarSinAlertaInput = z.infer<typeof aprobarSinAlertaSchema>

export const aplicarConteoSchema = z.object({ countId: id, note: z.string().trim().max(120, 'La nota es demasiado larga (máximo 120 caracteres).').optional() })
export type AplicarConteoInput = z.infer<typeof aplicarConteoSchema>

export const revisionSchema = z.object({
  countId: id,
  estado: z.enum(['PENDIENTE', 'CONTADO', 'RECONTAR', 'APROBADO', 'RECHAZADO']).optional(),
  limite: z.number().int().min(1).max(200).default(100),
  cursor: id.optional(),
})
export type RevisionInput = z.infer<typeof revisionSchema>

// ─── F6.5c: lo que pide la pantalla de contar ─────────────────────────────────────────────────────────────────────────

export const resolverProductoConteoSchema = z.object({ countId: id, code: z.string().trim().min(1, 'Escribe o escanea un código.').max(64, 'El código es demasiado largo.') })
export type ResolverProductoConteoInput = z.infer<typeof resolverProductoConteoSchema>
export const buscarProductosConteoSchema = z.object({ countId: id, q: z.string().trim().max(80, 'La búsqueda es demasiado larga.') })
export type BuscarProductosConteoInput = z.infer<typeof buscarProductosConteoSchema>
export const misPasadasSchema = z.object({ countId: id })
export type MisPasadasInput = z.infer<typeof misPasadasSchema>
export const buscarProductosSeleccionSchema = z.object({ q: z.string().trim().max(80, 'La búsqueda es demasiado larga.') })
