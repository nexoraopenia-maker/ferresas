import { diaLocal, medianoche } from '@/lib/periodos'

/**
 * El periodo de un reporte: SIEMPRE días civiles DEL NEGOCIO (su zona horaria), nunca los del servidor.
 *
 * Un periodo va de la medianoche del primer día (incluida) a la medianoche del día siguiente al último (excluida). Así una venta de las
 * 23:59 en Lima cae en su día aunque en UTC ya sea mañana, y dos periodos contiguos nunca se solapan ni dejan huecos.
 *
 * PURO: recibe «ahora» y la zona; no lee reloj ni base. Las semanas empiezan el LUNES.
 */

export const PRESETS_PERIODO = ['HOY', 'AYER', 'SEMANA', 'SEMANA_PASADA', 'MES', 'MES_PASADO', 'ULTIMOS_30', 'RANGO'] as const
export type PresetPeriodo = (typeof PRESETS_PERIODO)[number]

export const ETIQUETA_PRESET: Record<PresetPeriodo, string> = {
  HOY: 'Hoy', AYER: 'Ayer', SEMANA: 'Esta semana', SEMANA_PASADA: 'Semana pasada', MES: 'Este mes', MES_PASADO: 'Mes pasado',
  ULTIMOS_30: 'Últimos 30 días', RANGO: 'Rango de fechas',
}

export const MAX_DIAS_PERIODO = 366
export type Granularidad = 'dia' | 'semana' | 'mes'

export interface PeriodoElegido {
  preset: PresetPeriodo
  /** Primer instante del periodo (incluido). */
  desde: Date
  /** Primer instante FUERA del periodo (excluido). */
  hasta: Date
  /** Primer y último día civil, `AAAA-MM-DD` (ambos incluidos). */
  desdeDia: string
  hastaDia: string
  dias: number
}

const DIA = /^(\d{4})-(\d{2})-(\d{2})$/

function partes(dia: string): { y: number; m: number; d: number } {
  const m = DIA.exec(dia)
  if (!m) throw new RangeError(`Fecha no válida: ${dia}`)
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) }
}

/** El día civil `dia` desplazado `n` días. Aritmética de calendario pura (UTC), sin zona horaria de por medio. */
export function sumarDiasDia(dia: string, n: number): string {
  const { y, m, d } = partes(dia)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

/** ¿Existe ese día en el calendario? (31 de febrero → no) */
export function diaExiste(dia: string): boolean {
  const p = DIA.exec(dia)
  if (!p) return false
  const { y, m, d } = partes(dia)
  const f = new Date(Date.UTC(y, m - 1, d))
  return f.getUTCFullYear() === y && f.getUTCMonth() === m - 1 && f.getUTCDate() === d
}

export function diasEntre(desdeDia: string, hastaDia: string): number {
  const a = partes(desdeDia), b = partes(hastaDia)
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000) + 1
}

/** Lunes de la semana que contiene a `dia`. */
export function lunesDe(dia: string): string {
  const { y, m, d } = partes(dia)
  const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7   // lunes = 0
  return sumarDiasDia(dia, -dow)
}

function primerDiaDelMes(dia: string): string { return `${dia.slice(0, 7)}-01` }
function ultimoDiaDelMes(dia: string): string {
  const { y, m } = partes(dia)
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
}

function construir(preset: PresetPeriodo, desdeDia: string, hastaDia: string, zona: string): PeriodoElegido {
  const a = partes(desdeDia), b = partes(hastaDia)
  return {
    preset, desdeDia, hastaDia, dias: diasEntre(desdeDia, hastaDia),
    desde: medianoche(zona, a.y, a.m, a.d),
    hasta: medianoche(zona, b.y, b.m, b.d + 1),
  }
}

export interface EntradaPeriodo { preset?: string | null; desde?: string | null; hasta?: string | null }

/**
 * Resuelve lo que eligió la persona. ESTRICTO: un preset desconocido o un rango imposible lanza `RangeError` con un mensaje para mostrar;
 * quien lo llama decide si vuelve al periodo por defecto (las páginas lo hacen: una dirección manipulada no debe dar un error).
 */
export function resolverPeriodo(entrada: EntradaPeriodo, ahora: Date, zona: string): PeriodoElegido {
  const preset = (entrada.preset ?? 'MES').toString().toUpperCase() as PresetPeriodo
  if (!PRESETS_PERIODO.includes(preset)) throw new RangeError('El periodo elegido no existe.')
  const hoy = diaLocal(zona, ahora)

  switch (preset) {
    case 'HOY': return construir(preset, hoy, hoy, zona)
    case 'AYER': { const d = sumarDiasDia(hoy, -1); return construir(preset, d, d, zona) }
    case 'SEMANA': return construir(preset, lunesDe(hoy), hoy, zona)
    case 'SEMANA_PASADA': { const l = sumarDiasDia(lunesDe(hoy), -7); return construir(preset, l, sumarDiasDia(l, 6), zona) }
    case 'MES': return construir(preset, primerDiaDelMes(hoy), hoy, zona)
    case 'MES_PASADO': { const ultimo = sumarDiasDia(primerDiaDelMes(hoy), -1); return construir(preset, primerDiaDelMes(ultimo), ultimo, zona) }
    case 'ULTIMOS_30': return construir(preset, sumarDiasDia(hoy, -29), hoy, zona)
    case 'RANGO': {
      const d = (entrada.desde ?? '').trim(), h = (entrada.hasta ?? '').trim()
      if (!d || !h) throw new RangeError('Elige las dos fechas del rango.')
      if (!diaExiste(d) || !diaExiste(h)) throw new RangeError('Las fechas van como AAAA-MM-DD y deben existir.')
      if (d > h) throw new RangeError('La fecha «hasta» debe ser igual o posterior a «desde».')
      if (diasEntre(d, h) > MAX_DIAS_PERIODO) throw new RangeError(`El rango no puede pasar de ${MAX_DIAS_PERIODO} días.`)
      return construir(preset, d, h, zona)
    }
  }
}

/** Cómo agrupar por defecto: diario hasta ~2 meses, semanal hasta ~6 y mensual más allá. */
export function granularidadAuto(dias: number): Granularidad {
  return dias <= 62 ? 'dia' : dias <= 183 ? 'semana' : 'mes'
}

/** La clave del grupo al que pertenece un instante: el día, el lunes de su semana o `AAAA-MM`. */
export function claveDeGrupo(instante: Date, zona: string, g: Granularidad): string {
  const dia = diaLocal(zona, instante)
  return g === 'dia' ? dia : g === 'semana' ? lunesDe(dia) : dia.slice(0, 7)
}

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'setiembre', 'octubre', 'noviembre', 'diciembre']
const dmy = (dia: string) => `${dia.slice(8, 10)}/${dia.slice(5, 7)}/${dia.slice(0, 4)}`

export function etiquetaDeGrupo(clave: string, g: Granularidad): string {
  if (g === 'dia') return dmy(clave)
  if (g === 'semana') return `Semana del ${dmy(clave)}`
  return `${MESES[Number(clave.slice(5, 7)) - 1]} ${clave.slice(0, 4)}`
}

/** TODOS los grupos del periodo, en orden, incluidos los que no tienen ventas: la serie no tiene huecos. */
export function gruposDelPeriodo(p: Pick<PeriodoElegido, 'desdeDia' | 'hastaDia'>, g: Granularidad): { clave: string; etiqueta: string }[] {
  const claves: string[] = []
  for (let d = p.desdeDia; d <= p.hastaDia; d = sumarDiasDia(d, 1)) {
    const k = g === 'dia' ? d : g === 'semana' ? lunesDe(d) : d.slice(0, 7)
    if (claves[claves.length - 1] !== k) claves.push(k)
  }
  return claves.map((clave) => ({ clave, etiqueta: etiquetaDeGrupo(clave, g) }))
}

/** Texto del periodo para pantalla y archivos: «01/10/2026 – 26/10/2026» (o un solo día). */
export function describirPeriodo(p: Pick<PeriodoElegido, 'desdeDia' | 'hastaDia'>): string {
  return p.desdeDia === p.hastaDia ? dmy(p.desdeDia) : `${dmy(p.desdeDia)} – ${dmy(p.hastaDia)}`
}
