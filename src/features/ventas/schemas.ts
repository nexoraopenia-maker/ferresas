import { z } from 'zod'
import { PRESETS_PERIODO } from '@/features/reportes/periodo'

const dia = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha va como AAAA-MM-DD.')

export const ESTADOS_VENTA = ['COMPLETADA', 'ANULADA', 'DEVUELTA'] as const
export type EstadoVenta = (typeof ESTADOS_VENTA)[number]
export const ETIQUETA_ESTADO_VENTA: Record<EstadoVenta, string> = { COMPLETADA: 'Completada', ANULADA: 'Anulada', DEVUELTA: 'Devuelta' }

export const COMPROBANTES_FILTRO = ['BOLETA', 'FACTURA', 'SIN'] as const
export const ETIQUETA_COMPROBANTE_FILTRO: Record<(typeof COMPROBANTES_FILTRO)[number], string> = { BOLETA: 'Boleta', FACTURA: 'Factura', SIN: 'Sin comprobante (nota de venta)' }

/** Un cursor es «instante ISO|id» de la última venta vista. */
export const CURSOR_VENTAS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\|[A-Za-z0-9_-]{8,40}$/

/** Los filtros del historial, tal como viajan por la dirección. Sin nada: la última semana, todas las sucursales y estados. */
export const parametrosVentasListaSchema = z.object({
  p: z.enum(PRESETS_PERIODO).default('SEMANA'),
  desde: dia.optional(),
  hasta: dia.optional(),
  sucursal: z.string().regex(/^[A-Za-z0-9_-]{8,40}$/).optional(),
  estado: z.enum(ESTADOS_VENTA).optional(),
  comprobante: z.enum(COMPROBANTES_FILTRO).optional(),
  q: z.string().trim().min(2, 'Escribe al menos 2 caracteres para buscar.').max(60).optional(),
  cursor: z.string().regex(CURSOR_VENTAS).optional(),
})
export type ParametrosVentasLista = z.infer<typeof parametrosVentasListaSchema>
export const TAMANO_PAGINA_VENTAS = 25
