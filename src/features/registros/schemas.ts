import { z } from 'zod'
import { PRESETS_PERIODO } from '@/features/reportes/periodo'

const dia = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha va como AAAA-MM-DD.')

/** Los registros de ventas y de compras trabajan sobre un periodo. Sin nada: este mes. */
export const parametrosRegistrosSchema = z.object({
  p: z.enum(PRESETS_PERIODO).default('MES'),
  desde: dia.optional(),
  hasta: dia.optional(),
})
export type ParametrosRegistros = z.infer<typeof parametrosRegistrosSchema>

export const TIPOS_REGISTRO = ['ventas', 'compras'] as const
export type TipoRegistro = (typeof TIPOS_REGISTRO)[number]
export const ETIQUETA_REGISTRO: Record<TipoRegistro, string> = { ventas: 'Registro de ventas', compras: 'Registro de compras' }
