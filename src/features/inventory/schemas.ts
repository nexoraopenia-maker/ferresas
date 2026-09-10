import { z } from 'zod'

/**
 * Validación de entrada del inventario (§6.3).
 *
 * Los tipos de la app se DERIVAN de estos esquemas (`z.infer`), no se
 * duplican a mano (§7).
 *
 * Nota sobre `tenantId`: NO aparece en ningún esquema, a propósito. Si el
 * cliente pudiera enviarlo, existiría un camino por el que un tenant escribe
 * en otro. El tenantId sale siempre de la sesión (§3).
 */

/** Cantidades con hasta 4 decimales: se vende media plancha y 2.5 m de cable. */
const cantidad = z
  .number({ error: 'Ingresa una cantidad.' })
  .finite('La cantidad no es un número válido.')
  .refine((n) => Number.isFinite(n * 10_000) && Math.abs(n) < 1e9, {
    message: 'La cantidad está fuera de rango.',
  })
  .refine((n) => Math.round(n * 10_000) === n * 10_000, {
    message: 'Máximo 4 decimales.',
  })

const cantidadPositiva = cantidad.refine((n) => n > 0, {
  message: 'La cantidad debe ser mayor que cero.',
})

const id = z.string().min(1).max(64)

/** El motivo es texto libre que va al AuditLog: se acota y se limpia. */
const motivo = z
  .string()
  .trim()
  .min(3, 'Explica el motivo (mínimo 3 caracteres).')
  .max(280, 'El motivo es demasiado largo.')

const base = {
  productId: id,
  variantId: id.nullish(),
  warehouseId: id,
  /**
   * Generada por el cliente (crypto.randomUUID) ANTES de enviar. Si el
   * almacenero pierde señal y la app reintenta, el movimiento se aplica una
   * sola vez (§5.1: "conectividad intermitente").
   */
  idempotencyKey: z.uuid('Clave de idempotencia inválida.').optional(),
  source: z.enum(['MANUAL', 'ESCANER', 'CONTEO']).default('MANUAL'),
}

/**
 * Unión discriminada por tipo. No es cosmética: cada tipo tiene reglas
 * distintas y un esquema plano obligaría a validarlas a mano después.
 *
 *  ENTRADA / SALIDA -> `quantity` es un DELTA (siempre positivo; el signo lo
 *                      pone el tipo). Motivo opcional.
 *  AJUSTE           -> `quantity` es el CONTEO ABSOLUTO resultante, no un
 *                      delta. Motivo OBLIGATORIO (§6.6) y requiere
 *                      `expectedVersion` para el bloqueo optimista: un ajuste
 *                      se calcula contra lo que el operario vio en pantalla.
 */
export const createStockMovementSchema = z.discriminatedUnion('type', [
  z.object({
    ...base,
    type: z.literal('ENTRADA'),
    quantity: cantidadPositiva,
    reason: motivo.optional(),
    unitCost: cantidad.nonnegative().optional(),
  }),
  z.object({
    ...base,
    type: z.literal('SALIDA'),
    quantity: cantidadPositiva,
    reason: motivo.optional(),
  }),
  z.object({
    ...base,
    type: z.literal('AJUSTE'),
    /** Conteo físico: cero es un valor legítimo (se acabó el producto). */
    quantity: cantidad.nonnegative('El conteo no puede ser negativo.'),
    reason: motivo,
    expectedVersion: z.number().int().nonnegative(),
  }),
])

export type CreateStockMovementInput = z.infer<typeof createStockMovementSchema>

export const findProductByCodeSchema = z.object({
  /** Código de barras leído o tecleado. Se normaliza antes de buscar. */
  code: z
    .string()
    .trim()
    .min(1, 'Escribe un código.')
    .max(64, 'El código es demasiado largo.'),
  warehouseId: id.optional(),
})

export type FindProductByCodeInput = z.infer<typeof findProductByCodeSchema>

/**
 * Alta exprés desde el escáner (§5.1).
 *
 * Pide lo MÍNIMO para que el producto exista y tenga stock: nombre, precio y
 * cuántos hay. Todo lo demás (categoría, proveedor, costo, mínimo) se
 * completa después desde el catálogo. Un formulario largo en el pasillo del
 * almacén, con guantes, no lo llena nadie: se abandona y el producto se queda
 * sin registrar, que es peor que registrarlo incompleto.
 */
export const createProductExpressSchema = z.object({
  /** El código que se acaba de escanear. Puede faltar si se tecleó a mano. */
  barcode: z
    .string()
    .trim()
    .max(64, 'El código es demasiado largo.')
    .optional()
    .transform((v) => (v ? v : undefined)),
  sku: z.string().trim().min(1).max(64).optional(),
  name: z
    .string()
    .trim()
    .min(2, 'Ponle un nombre al producto.')
    .max(160, 'El nombre es demasiado largo.'),
  salePrice: cantidad.nonnegative('El precio no puede ser negativo.'),
  costPrice: cantidad.nonnegative('El costo no puede ser negativo.').optional(),
  unitType: z
    .enum([
      'UNIDAD', 'KILOGRAMO', 'GRAMO', 'METRO', 'CENTIMETRO', 'LITRO', 'GALON',
      'CAJA', 'PAQUETE', 'DOCENA', 'MILLAR', 'ROLLO', 'PLANCHA', 'BOLSA',
      'JUEGO', 'PAR', 'SERVICIO',
    ])
    .default('UNIDAD'),
  /** Conteo inicial. Cero es válido: registrar el producto antes de recibirlo. */
  initialStock: cantidad.nonnegative('El stock inicial no puede ser negativo.').default(0),
  minStock: cantidad.nonnegative('El mínimo no puede ser negativo.').default(0),
  warehouseId: id,
  idempotencyKey: z.uuid('Clave de idempotencia inválida.').optional(),
})

export type CreateProductExpressInput = z.infer<typeof createProductExpressSchema>
