/**
 * Fechas en la zona horaria del negocio.
 *
 * ─── POR QUÉ NO SE USA `toLocaleString()` A SECAS ────────────────────────
 *
 * En Vercel el servidor corre en UTC. `new Date(x).toLocaleString('es-PE')`
 * dentro de un Server Component usa la zona del SERVIDOR, no la del negocio:
 * una venta registrada a las 21:00 en Lima (02:00 UTC del día siguiente) se
 * imprimiría fechada al día siguiente. En un comprobante eso no es un detalle
 * cosmético — la fecha de emisión determina el periodo tributario.
 *
 * Perú no aplica horario de verano, así que hoy el desfase es constante
 * (-05:00); aun así se pasa la zona por nombre y no el offset, porque el
 * negocio puede configurar otra y porque un offset fijo es precisamente la
 * clase de atajo que falla el día que deja de ser cierto.
 */

export const ZONA_POR_DEFECTO = 'America/Lima'
export const LOCALE_POR_DEFECTO = 'es-PE'

export interface OpcionesFecha {
  /** Incluye hora y minuto en formato 24 h. */
  conHora?: boolean
}

/**
 * Formatea en la zona indicada. Nunca lanza: una zona o un locale inválidos
 * en la configuración del tenant degradan a ISO en lugar de tumbar la
 * impresión del ticket.
 */
export function formatearFechaLocal(
  valor: Date | string,
  zonaHoraria: string = ZONA_POR_DEFECTO,
  locale: string = LOCALE_POR_DEFECTO,
  { conHora = true }: OpcionesFecha = {},
): string {
  const fecha = valor instanceof Date ? valor : new Date(valor)
  if (Number.isNaN(fecha.getTime())) return '—'

  try {
    return new Intl.DateTimeFormat(locale || LOCALE_POR_DEFECTO, {
      timeZone: zonaHoraria || ZONA_POR_DEFECTO,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      ...(conHora ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}),
    }).format(fecha)
  } catch {
    return fecha.toISOString().slice(0, conHora ? 16 : 10).replace('T', ' ')
  }
}
