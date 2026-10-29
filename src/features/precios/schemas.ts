import { z } from 'zod'
import { MAX_TRAMOS_POR_ENTRADA } from '@/features/pos/precios-reglas'

const id = z.string().trim().min(1).max(64)
const decimales4 = (n: number) => Math.abs(Math.round(n * 10_000) / 10_000 - n) < 1e-9

const nombre = z.string().trim().min(2, 'El nombre necesita al menos 2 letras.').max(40, 'El nombre pasa de 40 caracteres.')
const codigo = z.string().trim().regex(/^[A-Za-z0-9_-]{1,30}$/, 'El código admite letras, números, guion y guion bajo (hasta 30).')

const precio = z.number().finite('Escribe un número.').min(0, 'El precio no puede ser negativo.').max(99_999_999, 'El precio está fuera de rango.').refine(decimales4, 'Hasta 4 decimales.')
const cantidadMinima = z.number().finite('Escribe un número.').gt(0, 'La cantidad mínima debe ser mayor que cero.').max(999_999_999, 'La cantidad es demasiado grande.').refine(decimales4, 'Hasta 4 decimales.')

export const MAX_CAMBIOS_PRECIOS = 1000

export const crearListaSchema = z.object({ name: nombre, code: codigo.nullish() })
export type CrearListaInput = z.infer<typeof crearListaSchema>

export const editarListaSchema = z.object({ priceListId: id, name: nombre.optional(), code: codigo.nullish() }).refine((v) => v.name !== undefined || v.code !== undefined, { message: 'No hay nada que cambiar.' })
export type EditarListaInput = z.infer<typeof editarListaSchema>

export const darDeBajaListaSchema = z.object({ priceListId: id })
export type DarDeBajaListaInput = z.infer<typeof darDeBajaListaSchema>

export const tramoSchema = z.object({ minQuantity: cantidadMinima, unitPrice: precio })

/**
 * Un cambio de precios de UN producto en UNA lista (`priceListId` null = la Base, donde solo se editan tramos: su precio plano es `Product.salePrice`).
 * `price`: undefined = no tocar, null = quitar el plano (la entrada queda solo con tramos), número = fijarlo. `tiers`: undefined = no tocar, [] = quitar todos, lista = reemplazarlos.
 * `eliminar` = la lista deja de tener entrada para el producto (vuelve a heredar la Base completa).
 */
export const cambioPrecioSchema = z.object({
  productId: id,
  price: precio.nullish(),
  tiers: z.array(tramoSchema).max(MAX_TRAMOS_POR_ENTRADA, `Hasta ${MAX_TRAMOS_POR_ENTRADA} tramos por producto.`).optional(),
  eliminar: z.boolean().optional(),
}).superRefine((c, ctx) => {
  if (c.eliminar && (c.price !== undefined || c.tiers !== undefined)) ctx.addIssue({ code: 'custom', path: ['eliminar'], message: 'Quitar la entrada no admite otros cambios.' })
  if (!c.eliminar && c.price === undefined && c.tiers === undefined) ctx.addIssue({ code: 'custom', path: ['price'], message: 'No hay nada que cambiar.' })
})
export type CambioPrecioInput = z.infer<typeof cambioPrecioSchema>

export const guardarPreciosSchema = z.object({
  priceListId: id.nullable(),
  cambios: z.array(cambioPrecioSchema).min(1, 'No hay cambios.').max(MAX_CAMBIOS_PRECIOS, `Máximo ${MAX_CAMBIOS_PRECIOS} cambios por vez.`),
})
export type GuardarPreciosInput = z.infer<typeof guardarPreciosSchema>

export const asignarListaClienteSchema = z.object({ customerId: id, priceListId: id.nullable() })
export type AsignarListaClienteInput = z.infer<typeof asignarListaClienteSchema>

export const listarPreciosSchema = z.object({ priceListId: id.nullable(), q: z.string().trim().max(80).optional(), pagina: z.number().int().min(0).max(10_000).optional() })
export type ListarPreciosInput = z.infer<typeof listarPreciosSchema>
