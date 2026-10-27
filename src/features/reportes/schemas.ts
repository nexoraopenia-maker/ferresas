import { z } from 'zod'
import { PRESETS_PERIODO } from './periodo'

const dia = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha va como AAAA-MM-DD.')

/** Los parámetros de un reporte de ventas, tal como viajan por la dirección. Todo es opcional: sin nada, «este mes», por día/semana/mes automático. */
export const parametrosVentasSchema = z.object({
  p: z.enum(PRESETS_PERIODO).default('MES'),
  desde: dia.optional(),
  hasta: dia.optional(),
  agrupar: z.enum(['auto', 'dia', 'semana', 'mes']).default('auto'),
  atrib: z.enum(['VENDEDOR', 'COBRO']).default('VENDEDOR'),
})
export type ParametrosVentas = z.infer<typeof parametrosVentasSchema>

export const TIPOS_REPORTE_VENTAS = ['periodo', 'vendedor', 'medios', 'cobros'] as const
export type TipoReporteVentas = (typeof TIPOS_REPORTE_VENTAS)[number]
export const ETIQUETA_REPORTE_VENTAS: Record<TipoReporteVentas, string> = {
  periodo: 'Por periodo', vendedor: 'Por vendedor', medios: 'Por medio de pago', cobros: 'Cobros',
}

// ─── Margen, inventario valorizado y análisis ABC (exigen `productos.ver_costo`) ─────────────────────────────────────────────────────

export const TIPOS_REPORTE_COSTOS = ['margen', 'inventario', 'abc'] as const
export type TipoReporteCostos = (typeof TIPOS_REPORTE_COSTOS)[number]
export const ETIQUETA_REPORTE_COSTOS: Record<TipoReporteCostos, string> = { margen: 'Margen por producto', inventario: 'Valor del inventario', abc: 'Análisis ABC' }

const umbral = z.coerce.number().min(1, 'El umbral va entre 1 y 99.').max(99, 'El umbral va entre 1 y 99.')

/** Margen y ABC trabajan sobre un periodo; el ABC además sobre qué se ordena y dónde cortan A y B. El inventario no tiene periodo: es de hoy. */
export const parametrosCostosSchema = z.object({
  p: z.enum(PRESETS_PERIODO).default('MES'),
  desde: dia.optional(),
  hasta: dia.optional(),
  base: z.enum(['VENTAS', 'UTILIDAD']).default('VENTAS'),
  a: umbral.default(80),
  b: umbral.default(95),
}).refine((x) => x.a < x.b, { message: 'El umbral de A debe ser menor que el de B.', path: ['a'] })
export type ParametrosCostos = z.infer<typeof parametrosCostosSchema>
