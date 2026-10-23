import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { modoFiscal, type ModoFiscal } from './modo-fiscal'

/**
 * Alarma de comprobantes SIN ENVIAR.
 *
 * Con la facturación real habilitada, un comprobante que no sale a SUNAT es un problema
 * que crece con el tiempo. Pausar el envío (a propósito) o que el proveedor falle dejan
 * documentos esperando: el dueño y el SuperAdmin tienen que VERLO, con cuántos son y cuánto
 * lleva el más viejo.
 *
 * ⚠️ LOS UMBRALES POR DEFECTO NO SON PLAZOS DE SUNAT. Son valores de trabajo (24 h y 72 h)
 * a la espera de que el responsable fiscal confirme los plazos que correspondan; se pueden
 * cambiar por negocio (columnas `fiscalAlert*Hours`) o para toda la plataforma con las
 * variables FISCAL_ALERTA_AVISO_HORAS y FISCAL_ALERTA_CRITICO_HORAS.
 */

export const UMBRAL_AVISO_POR_DEFECTO_HORAS = 24
export const UMBRAL_CRITICO_POR_DEFECTO_HORAS = 72

export interface Umbrales { avisoHoras: number; criticoHoras: number }

const entero = (v: string | undefined) => {
  const n = Number(v)
  return v !== undefined && Number.isInteger(n) && n > 0 ? n : null
}

/** Umbrales efectivos: el del negocio, si no el de la plataforma (entorno), si no el de trabajo. */
export function umbralesEfectivos(
  negocio: { fiscalAlertWarnHours: number | null; fiscalAlertCriticalHours: number | null },
  entorno: Record<string, string | undefined> = process.env,
): Umbrales {
  const avisoBase = entero(entorno.FISCAL_ALERTA_AVISO_HORAS) ?? UMBRAL_AVISO_POR_DEFECTO_HORAS
  const criticoBase = entero(entorno.FISCAL_ALERTA_CRITICO_HORAS) ?? UMBRAL_CRITICO_POR_DEFECTO_HORAS
  let aviso = negocio.fiscalAlertWarnHours ?? avisoBase
  let critico = negocio.fiscalAlertCriticalHours ?? criticoBase
  // Una combinación incoherente (aviso ≥ crítico) no puede dejar la alarma muda: se corrige hacia arriba.
  if (aviso >= critico) critico = aviso + 1
  return { avisoHoras: aviso, criticoHoras: critico }
}

export type NivelAlarma = 'ok' | 'aviso' | 'critico'

export interface EstadoEnvioFiscal {
  modo: ModoFiscal
  pausado: boolean
  sinEnviar: number
  /** Horas que lleva el comprobante pendiente más antiguo; null si no hay. */
  masAntiguoHoras: number | null
  umbrales: Umbrales
  nivel: NivelAlarma
  /** ¿Hay que mostrar el aviso? (pausa, o sin enviar por encima del umbral de aviso) */
  mostrar: boolean
}

/** Puro: dado el modo, lo pendiente y los umbrales, ¿qué nivel de alarma toca? */
export function nivelDeAlarma(i: {
  modo: ModoFiscal
  sinEnviar: number
  masAntiguoHoras: number | null
  umbrales: Umbrales
}): { nivel: NivelAlarma; mostrar: boolean } {
  // En ensayo y en demo no hay nada que enviar: no hay alarma posible.
  if (i.modo === 'ENSAYO' || i.modo === 'DEMO') return { nivel: 'ok', mostrar: false }

  let nivel: NivelAlarma = 'ok'
  if (i.sinEnviar > 0 && i.masAntiguoHoras !== null) {
    if (i.masAntiguoHoras >= i.umbrales.criticoHoras) nivel = 'critico'
    else if (i.masAntiguoHoras >= i.umbrales.avisoHoras) nivel = 'aviso'
  }
  // Una pausa se ve SIEMPRE, aunque aún no haya nada pendiente: es un estado excepcional.
  if (i.modo === 'PAUSADO' && nivel === 'ok') nivel = 'aviso'
  return { nivel, mostrar: nivel !== 'ok' }
}

export const horasEntre = (desde: Date, hasta: Date) => Math.max(0, (hasta.getTime() - desde.getTime()) / 3_600_000)

/** Texto de antigüedad para la pantalla: «45 min», «5 h», «3 días». */
export function describirAntiguedad(horas: number): string {
  if (horas < 1) return `${Math.max(1, Math.round(horas * 60))} min`
  if (horas < 48) return `${Math.round(horas)} h`
  return `${Math.round(horas / 24)} días`
}

/** Estado de envío fiscal del negocio del contexto. */
export async function estadoEnvioFiscal(db: TenantPrismaClient, ahora: Date = new Date()): Promise<EstadoEnvioFiscal> {
  const t = await db.tenant.findFirstOrThrow({
    select: { isDemo: true, realBillingEnabledAt: true, realBillingPausedAt: true, fiscalAlertWarnHours: true, fiscalAlertCriticalHours: true },
  })
  const modo = modoFiscal(t)
  const umbrales = umbralesEfectivos(t)
  if (modo === 'ENSAYO' || modo === 'DEMO') {
    return { modo, pausado: false, sinEnviar: 0, masAntiguoHoras: null, umbrales, nivel: 'ok', mostrar: false }
  }
  // «Sin enviar» = PENDIENTE y real. Los documentos de prueba NUNCA cuentan.
  const agg = await db.taxDocument.aggregate({
    where: { isTrial: false, status: 'PENDIENTE' },
    _count: { _all: true },
    _min: { issuedAt: true },
  })
  const sinEnviar = agg._count._all
  const masAntiguoHoras = agg._min.issuedAt ? horasEntre(agg._min.issuedAt, ahora) : null
  return { modo, pausado: modo === 'PAUSADO', sinEnviar, masAntiguoHoras, umbrales, ...nivelDeAlarma({ modo, sinEnviar, masAntiguoHoras, umbrales }) }
}
