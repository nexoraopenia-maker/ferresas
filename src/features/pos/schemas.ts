import { z } from 'zod'
import { tieneMaxDecimales } from '@/lib/dinero'
import { MENSAJE_FIADO_CLIENTE } from './pagos'

/**
 * Validación del Punto de Venta (§5.4).
 *
 * Igual que en inventario: `tenantId` NO aparece en ningún esquema. Y
 * tampoco los PRECIOS en su forma final — el carrito manda qué producto y
 * cuánto, y el servidor recalcula los importes leyendo el precio de la base.
 * Si el navegador pudiera fijar el total, cualquiera se vendería un taladro
 * a un sol.
 */

const cantidad = z
  .number({ error: 'Ingresa una cantidad.' })
  .finite('La cantidad no es válida.')
  .positive('La cantidad debe ser mayor que cero.')
  .refine((n) => tieneMaxDecimales(n, 4), 'Máximo 4 decimales.')
  .refine((n) => n < 1e9, 'La cantidad está fuera de rango.')

const importe = z
  .number()
  .finite()
  .nonnegative('No puede ser negativo.')
  .refine((n) => tieneMaxDecimales(n, 2), 'Máximo 2 decimales.')

const id = z.string().min(1).max(64)

export const saleLineSchema = z.object({
  productId: id,
  variantId: id.nullish(),
  /** SIEMPRE en la unidad BASE del producto (lo que mueve el stock). */
  quantity: cantidad,
  /**
   * Presentación con la que se vende (caja, saco…) y lo que se tecleó en sus unidades. Van juntas o ninguna. El servidor
   * RECALCULA la cantidad base desde la presentación guardada y rechaza si `quantity` no coincide: el cliente no decide ni
   * el stock ni el precio de una presentación.
   */
  presentationId: id.nullish(),
  enteredQuantity: z.union([z.string().trim().min(1).max(30), z.number().finite()]).nullish(),
  /**
   * Descuento por línea, en importe. Lo decide el vendedor en el mostrador,
   * así que sí viene del cliente — pero el servidor comprueba que no exceda
   * el subtotal de la línea.
   */
  discount: importe.default(0),
}).refine((l) => (l.presentationId == null) === (l.enteredQuantity == null), {
  message: 'La presentación y la cantidad ingresada van juntas.',
  path: ['presentationId'],
})

export const paymentLineSchema = z.object({
  method: z.enum([
    'EFECTIVO', 'TARJETA_DEBITO', 'TARJETA_CREDITO',
    'TRANSFERENCIA', 'YAPE', 'PLIN', 'CREDITO', 'OTRO',
  ]),
  amount: importe.refine((n) => n > 0, 'El monto debe ser mayor que cero.'),
  reference: z.string().trim().max(60).optional(),
})

export const registerSaleSchema = z.object({
  warehouseId: id,
  customerId: id.nullish(),
  /** Lista de precios (F6.7): ausente = la lista por defecto del cliente (si tiene), `null` = Base a propósito, un id = esa lista. El servidor recalcula los precios; esto solo elige la lista. */
  priceListId: id.nullable().optional(),
  /**
   * Lo que el POS mostró al cajero (F6.7c). Si el servidor calcula OTRO total —cambió un precio o una lista mientras armaba la venta—, rechaza con `PRICE_CHANGED` y el total de ahora,
   * en lugar de cobrar algo distinto de lo que el cliente vio. Opcional: cobrar un pedido o una cotización (precios congelados) no lo manda.
   */
  totalEsperado: z.number().finite().min(0).max(99_999_999).optional(),
  items: z.array(saleLineSchema).min(1, 'Agrega al menos un producto.').max(200),
  payments: z.array(paymentLineSchema).min(1, 'Registra al menos un pago.').max(5),
  documentType: z.enum(['NOTA_VENTA', 'BOLETA', 'FACTURA', 'TICKET']).default('NOTA_VENTA'),
  notes: z.string().trim().max(500).optional(),
  /**
   * Venta forzada por debajo del stock disponible.
   *
   * No es una chapuza: en una ferretería el inventario físico y el del
   * sistema divergen a diario —mercadería mal ubicada, un conteo pendiente,
   * una entrada que nadie registró—. Bloquear la venta cuando el producto
   * está ahí, en el mostrador, delante del cliente, hace que el cajero
   * abandone el sistema y apunte en un papel. Eso destruye el inventario
   * mucho más que un negativo temporal.
   *
   * El negativo queda MARCADO en la venta y AUDITADO, así que el dueño ve
   * exactamente qué productos necesitan conteo.
   */
  allowNegativeStock: z.boolean().default(false),
  /**
   * Generada por el cliente antes de enviar. Es lo que impide que un doble
   * toque en "Cobrar" con la red lenta registre la venta dos veces y
   * descuente el stock dos veces.
   */
  idempotencyKey: z.uuid().optional(),
}).refine((v) => !v.payments.some((p) => p.method === 'CREDITO') || !!v.customerId, {
  // El fiado necesita a quién cobrarle. (El servicio lo vuelve a exigir: este es el aviso temprano al cajero.)
  message: MENSAJE_FIADO_CLIENTE, path: ['customerId'],
})

export type SaleLineInput = z.infer<typeof saleLineSchema>
export type RegisterSaleInput = z.infer<typeof registerSaleSchema>

/** Búsqueda del POS: código escaneado, QR, SKU o texto libre. */
export const posLookupSchema = z.object({
  code: z.string().trim().min(1, 'Escribe o escanea un código.').max(64),
  warehouseId: id.optional(),
  /** Lista de precios con la que se arma el carrito (F6.7c): `null`/ausente = Base. Solo decide qué datos de precio se devuelven; el servidor recalcula al cobrar. */
  priceListId: id.nullable().optional(),
})

export type PosLookupInput = z.infer<typeof posLookupSchema>

/**
 * Alta o búsqueda rápida de cliente por documento, desde el mostrador.
 *
 * El largo del documento define su tipo, así que no se pregunta: 8 dígitos
 * es DNI, 11 es RUC. Obligar al cajero a elegir en un desplegable mientras
 * el cliente espera es fricción que no aporta nada — el número ya lo dice.
 */
export const customerByDocSchema = z.object({
  docNumber: z
    .string()
    .trim()
    .regex(/^\d{8}$|^\d{11}$/, 'El DNI tiene 8 dígitos y el RUC 11.'),
  /** Solo se usa al CREAR; si el cliente ya existe, se ignora. */
  name: z.string().trim().min(2).max(200).optional(),
})

export type CustomerByDocInput = z.infer<typeof customerByDocSchema>

/** Guardar el carrito como cotización. */
export const registerQuoteSchema = z.object({
  warehouseId: id,
  customerId: id.nullish(),
  /** Lista de precios (F6.7): ausente = la lista por defecto del cliente (si tiene), `null` = Base a propósito, un id = esa lista. */
  priceListId: id.nullable().optional(),
  items: z.array(saleLineSchema).min(1, 'Agrega al menos un producto.').max(200),
  /**
   * Días de validez. Por defecto 15: en ferretería los precios se mueven con
   * el tipo de cambio y el acero, y una cotización sin caducidad se convierte
   * en una promesa que el negocio no puede sostener.
   */
  validDays: z.number().int().min(1).max(90).default(15),
  notes: z.string().trim().max(500).optional(),
  idempotencyKey: z.uuid().optional(),
})

export type RegisterQuoteInput = z.infer<typeof registerQuoteSchema>

/** Convertir una cotización en venta. */
export const convertQuoteSchema = z.object({
  quoteId: id,
  payments: z.array(paymentLineSchema).min(1, 'Registra al menos un pago.').max(5),
  documentType: z.enum(['NOTA_VENTA', 'BOLETA', 'FACTURA', 'TICKET']).default('NOTA_VENTA'),
  allowNegativeStock: z.boolean().default(false),
  idempotencyKey: z.uuid().optional(),
})

export type ConvertQuoteInput = z.infer<typeof convertQuoteSchema>
