/**
 * Modo fiscal de un negocio (puro).
 *
 *   DEMO     cuenta de demostración: numera como un comprobante real pero habla
 *            solo con el proveedor simulado. Nunca llega nada a SUNAT.
 *   ENSAYO   negocio real que AÚN no habilitó la facturación real: sus documentos
 *            van en una serie de PRUEBA (PB001/PF001), sin valor tributario, y
 *            nunca se envían. La serie real no se toca.
 *   REAL     facturación real habilitada: serie real, y se envía.
 *   PAUSADO  real habilitada pero con el ENVÍO en pausa: la numeración sigue siendo
 *            real y los comprobantes esperan sin enviarse hasta reanudar.
 *
 * Por qué una serie propia para el ensayo: los números de una serie real que SUNAT
 * nunca vio dejarían un hueco irrecuperable el día que se enciende, y el cliente se
 * llevaría un papel con aspecto de boleta que no existe. Aparte, no hay nada que
 * «reiniciar» al encender: la serie real nace limpia.
 */

export type ModoFiscal = 'DEMO' | 'ENSAYO' | 'REAL' | 'PAUSADO'

export interface EstadoFiscalDelNegocio {
  isDemo: boolean
  realBillingEnabledAt: Date | null
  realBillingPausedAt: Date | null
}

export function modoFiscal(t: EstadoFiscalDelNegocio): ModoFiscal {
  if (t.isDemo) return 'DEMO'
  if (!t.realBillingEnabledAt) return 'ENSAYO'
  return t.realBillingPausedAt ? 'PAUSADO' : 'REAL'
}

/** ¿Los documentos que se emitan ahora llevan la serie de prueba? */
export const numeraEnPrueba = (m: ModoFiscal): boolean => m === 'ENSAYO'

/** ¿Puede este modo hablar con un proveedor? (La demo habla con el simulado.) */
export const puedeEnviarAlProveedor = (m: ModoFiscal): boolean => m === 'REAL' || m === 'DEMO'

/**
 * ¿Es enviable este documento? Un documento de PRUEBA no lo es nunca, en ningún modo.
 * Lo usan el envío directo y, cuando exista, la cola: así hay UN solo criterio.
 */
export function esEnviable(doc: { isTrial: boolean }, modo: ModoFiscal): boolean {
  return !doc.isTrial && puedeEnviarAlProveedor(modo)
}

export const ETIQUETA_MODO: Record<ModoFiscal, string> = {
  DEMO: 'Demostración',
  ENSAYO: 'Ensayo',
  REAL: 'Real',
  PAUSADO: 'Real (envío en pausa)',
}
