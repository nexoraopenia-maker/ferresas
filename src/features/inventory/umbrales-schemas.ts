import { z } from 'zod'

/**
 * Cambios de mínimos y máximos (F6.6b). Un cambio dice A QUÉ NIVEL se escribe: el almacén (override de una fila de stock), la variante o el producto (el predeterminado).
 * En `minimo` y `maximo`, `undefined` = no tocar y `null` = quitar el valor propio (vuelve a heredar; en el producto y la variante, el mínimo vuelve a 0 = «sin umbral»).
 */
const id = z.string().min(1).max(64)
const umbral = z.number().finite('Escribe un número.').min(0, 'No puede ser negativo.').max(999_999_999, 'Es demasiado grande.')
  .refine((n) => Math.round(n * 10_000) / 10_000 === n, 'Hasta 4 decimales.')

export const NIVELES_UMBRAL = ['ALMACEN', 'VARIANTE', 'PRODUCTO'] as const
export type NivelUmbral = (typeof NIVELES_UMBRAL)[number]

export const MAX_CAMBIOS_UMBRALES = 1000

export const cambioUmbralSchema = z.object({
  nivel: z.enum(NIVELES_UMBRAL),
  productId: id,
  variantId: id.nullish(),
  warehouseId: id.nullish(),
  minimo: umbral.nullish(),
  maximo: umbral.nullish(),
}).superRefine((c, ctx) => {
  if (c.nivel === 'ALMACEN' && !c.warehouseId) ctx.addIssue({ code: 'custom', path: ['warehouseId'], message: 'Falta el almacén.' })
  if (c.nivel !== 'ALMACEN' && c.warehouseId) ctx.addIssue({ code: 'custom', path: ['warehouseId'], message: 'Solo el nivel «almacén» lleva almacén.' })
  if (c.nivel === 'VARIANTE' && !c.variantId) ctx.addIssue({ code: 'custom', path: ['variantId'], message: 'Falta la variante.' })
  if (c.nivel === 'PRODUCTO' && c.variantId) ctx.addIssue({ code: 'custom', path: ['variantId'], message: 'El nivel «producto» no lleva variante.' })
  if (c.minimo === undefined && c.maximo === undefined) ctx.addIssue({ code: 'custom', path: ['minimo'], message: 'No hay nada que cambiar.' })
  if (typeof c.minimo === 'number' && typeof c.maximo === 'number' && c.maximo < c.minimo) ctx.addIssue({ code: 'custom', path: ['maximo'], message: 'El máximo no puede ser menor que el mínimo.' })
})
export type CambioUmbralInput = z.infer<typeof cambioUmbralSchema>

export const aplicarUmbralesSchema = z.object({
  cambios: z.array(cambioUmbralSchema).min(1, 'No hay cambios.').max(MAX_CAMBIOS_UMBRALES, `Máximo ${MAX_CAMBIOS_UMBRALES} cambios por vez.`),
})
export type AplicarUmbralesInput = z.infer<typeof aplicarUmbralesSchema>

export const listarUmbralesSchema = z.object({
  warehouseId: id.optional(),
  q: z.string().trim().max(80).optional(),
  pagina: z.number().int().min(0).max(10_000).optional(),
})
export type ListarUmbralesInput = z.infer<typeof listarUmbralesSchema>

export const analizarUmbralesCsvSchema = z.object({ contenido: z.string().min(1, 'El archivo está vacío.').max(2_000_000, 'El archivo es demasiado grande.') })
