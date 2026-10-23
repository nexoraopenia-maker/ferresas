import { randomUUID } from 'node:crypto'
import type { DependenciasEnvio } from '@/features/invoicing/envio'
import { adoptarHuerfanos, agotarVencidos, reclamarSiguiente } from './repositorio'
import { procesarFila, type ResultadoFila } from './procesar'
import { TIMEOUT_ENVIO_MS, tiempoRestante } from './reglas'

/**
 * Una pasada del worker. La dispara un programador EXTERNO (QStash, n8n con cron…): este módulo no
 * depende de ningún cron. Es seguro llamarla dos veces a la vez o solapada: cada fila se reclama de
 * forma atómica y con lease, así que dos pasadas nunca envían lo mismo.
 */

export interface OpcionesWorker {
  /** Identificador de esta pasada (dueño del lease). */
  workerId?: string
  /** Tiempo total disponible (ms): la duración máxima de la función menos un margen. */
  presupuestoMs?: number
  /** Margen que hace falta para empezar OTRO envío (por defecto el timeout del proveedor). */
  margenEnvioMs?: number
  /** Tope de filas por pasada. */
  maxFilas?: number
  /** Reloj inyectable (pruebas). */
  reloj?: () => Date
  /** Proveedor y credenciales inyectados (pruebas). En producción salen de la configuración del negocio. */
  deps?: DependenciasEnvio
}

export interface ResumenWorker {
  workerId: string
  adoptados: number
  agotadosPorCaida: number
  procesados: number
  completados: number
  reintentos: number
  agotados: number
  liberados: number
  consultas: number
  perdidos: number
  /** ¿Puede quedar trabajo? (se cortó por tiempo o por el tope de filas) */
  restante: boolean
  duracionMs: number
}

export const PRESUPUESTO_POR_DEFECTO_MS = 45_000
export const MAX_FILAS_POR_DEFECTO = 50

export async function ejecutarWorker(o: OpcionesWorker = {}): Promise<ResumenWorker> {
  const workerId = o.workerId ?? `w-${randomUUID().slice(0, 8)}`
  const presupuesto = o.presupuestoMs ?? PRESUPUESTO_POR_DEFECTO_MS
  const margen = o.margenEnvioMs ?? TIMEOUT_ENVIO_MS
  const maxFilas = o.maxFilas ?? MAX_FILAS_POR_DEFECTO
  const reloj = o.reloj ?? (() => new Date())
  const inicio = Date.now()

  const r: ResumenWorker = {
    workerId, adoptados: 0, agotadosPorCaida: 0, procesados: 0, completados: 0, reintentos: 0,
    agotados: 0, liberados: 0, consultas: 0, perdidos: 0, restante: false, duracionMs: 0,
  }

  // Mantenimiento previo, acotado y barato: huérfanos y filas cuyo worker murió en el último intento.
  r.adoptados = await adoptarHuerfanos(reloj(), 200)
  r.agotadosPorCaida = await agotarVencidos(reloj())

  const cuenta: Record<ResultadoFila, () => void> = {
    completado: () => r.completados++, reintento: () => r.reintentos++, agotado: () => r.agotados++,
    liberado: () => r.liberados++, consulta: () => r.consultas++, perdido: () => r.perdidos++,
  }

  for (;;) {
    if (r.procesados >= maxFilas) { r.restante = true; break }
    // Sin margen para un envío completo no se empieza otro: la función no debe cortarse a mitad.
    if (tiempoRestante(inicio, presupuesto, Date.now()) < margen) { r.restante = true; break }

    const fila = await reclamarSiguiente(workerId, reloj())
    if (!fila) break
    r.procesados++
    cuenta[await procesarFila(fila, o.deps ?? {}, reloj())]()
  }

  r.duracionMs = Date.now() - inicio
  return r
}
