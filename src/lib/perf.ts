/**
 * Medición de fases en el servidor.
 *
 * ─── POR QUÉ EXISTE ──────────────────────────────────────────────────────
 *
 * Medir desde un portátil no sirve: la ida y vuelta a Neon desde aquí son
 * 605 ms y desde Vercel 18 ms, así que cualquier conclusión local está
 * dominada por la distancia y no por el código. Y medir solo el TTFB desde
 * fuera tampoco distingue "el servidor tardó" de "la red tardó".
 *
 * Esto mide DENTRO del servidor, fase por fase, y el resultado sale por dos
 * vías:
 *   · Un log estructurado `[perf]` (visible en los logs de Vercel).
 *   · La cabecera `Server-Timing` cuando quien mide es un Route Handler,
 *     que es el único sitio de App Router donde se pueden poner cabeceras.
 */

export interface Fase {
  nombre: string
  ms: number
}

export class Medidor {
  private readonly fases: Fase[] = []
  private readonly t0 = performance.now()

  /** Mide una fase asíncrona y devuelve su resultado. */
  async fase<T>(nombre: string, fn: () => Promise<T>): Promise<T> {
    const t = performance.now()
    try {
      return await fn()
    } finally {
      this.fases.push({ nombre, ms: Math.round(performance.now() - t) })
    }
  }

  /** Marca una fase ya medida por fuera. */
  marca(nombre: string, ms: number): void {
    this.fases.push({ nombre, ms: Math.round(ms) })
  }

  get total(): number {
    return Math.round(performance.now() - this.t0)
  }

  get detalle(): Fase[] {
    return [...this.fases]
  }

  /**
   * Cabecera `Server-Timing`, que las herramientas de desarrollo del
   * navegador muestran en la pestaña de red sin necesidad de nada más.
   */
  serverTiming(): string {
    return [...this.fases, { nombre: 'total', ms: this.total }]
      .map((f) => `${f.nombre.replace(/[^a-zA-Z0-9_-]/g, '_')};dur=${f.ms}`)
      .join(', ')
  }

  /** Una línea por petición, para los logs de Vercel. */
  log(ruta: string): void {
    console.log(
      `[perf] ${ruta} total=${this.total}ms ` +
        this.fases.map((f) => `${f.nombre}=${f.ms}ms`).join(' '),
    )
  }
}
