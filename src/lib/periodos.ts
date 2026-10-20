/**
 * Hoy, esta semana y este mes DEL NEGOCIO, no del servidor.
 *
 * Vercel corre en UTC: «hoy» a las 8 p. m. en Lima ya es mañana para el
 * servidor, y el panel contaría las ventas de la tarde en el día siguiente.
 * Todo se calcula en la zona horaria del negocio (`Tenant.timezone`).
 *
 * Las semanas empiezan el LUNES, como en Perú.
 */

const PARTES = (zona: string, instante: Date) => {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: zona, hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
  })
  const p = Object.fromEntries(f.formatToParts(instante).map((x) => [x.type, x.value]))
  return {
    y: Number(p.year), m: Number(p.month), d: Number(p.day),
    h: Number(p.hour), mi: Number(p.minute), s: Number(p.second),
  }
}

/** Desfase de la zona respecto a UTC en ese instante, en milisegundos. */
export function desfaseMs(zona: string, instante: Date): number {
  const p = PARTES(zona, instante)
  const comoUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s)
  return comoUtc - Math.floor(instante.getTime() / 1000) * 1000
}

/** Instante real en que empieza el día civil (y, m, d) en esa zona. `m` es 1-12. */
export function medianoche(zona: string, y: number, m: number, d: number): Date {
  const base = Date.UTC(y, m - 1, d)
  const primera = base - desfaseMs(zona, new Date(base))
  // Se recalcula con el desfase del propio instante por si cruza un cambio de hora.
  return new Date(base - desfaseMs(zona, new Date(primera)))
}

/** `YYYY-MM-DD` del día local de ese instante. */
export function diaLocal(zona: string, instante: Date): string {
  const p = PARTES(zona, instante)
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`
}

export interface Rango { desde: Date; hasta: Date }

export interface Periodos {
  hoy: Rango
  semana: Rango
  mes: Rango
  /** Los últimos 7 días, hoy incluido, para el gráfico. */
  ultimos7: Rango
  /** Etiquetas `YYYY-MM-DD` de esos 7 días, del más antiguo al de hoy. */
  dias7: string[]
}

export function periodos(ahora: Date, zona: string): Periodos {
  const p = PARTES(zona, ahora)
  const diaSemana = (new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay() + 6) % 7 // lunes = 0
  const manana = medianoche(zona, p.y, p.m, p.d + 1)
  const dias7 = Array.from({ length: 7 }, (_, i) =>
    diaLocal(zona, medianoche(zona, p.y, p.m, p.d - 6 + i)))
  return {
    hoy: { desde: medianoche(zona, p.y, p.m, p.d), hasta: manana },
    semana: { desde: medianoche(zona, p.y, p.m, p.d - diaSemana), hasta: manana },
    mes: { desde: medianoche(zona, p.y, p.m, 1), hasta: manana },
    ultimos7: { desde: medianoche(zona, p.y, p.m, p.d - 6), hasta: manana },
    dias7,
  }
}
