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
