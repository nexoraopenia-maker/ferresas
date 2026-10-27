import { z } from 'zod'
import { PRESETS_PERIODO } from '@/features/reportes/periodo'
import { CATEGORIAS } from './catalogo'

const dia = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha va como AAAA-MM-DD.')

/** Un cursor es «instante ISO|id» del último registro visto. */
export const CURSOR = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\|[A-Za-z0-9_-]{8,40}$/

/** Los filtros del registro de auditoría, tal como viajan por la dirección. Sin nada: la última semana, todo, sin filtrar. */
export const parametrosAuditoriaSchema = z.object({
  p: z.enum(PRESETS_PERIODO).default('SEMANA'),
  desde: dia.optional(),
  hasta: dia.optional(),
  categoria: z.enum(['TODAS', ...CATEGORIAS]).default('TODAS'),
  actor: z.string().regex(/^[A-Za-z0-9_-]{8,40}$/).optional(),
  entidad: z.string().trim().min(1).max(80).optional(),
  cursor: z.string().regex(CURSOR).optional(),
})
export type ParametrosAuditoria = z.infer<typeof parametrosAuditoriaSchema>
export const TAMANO_PAGINA = 50
