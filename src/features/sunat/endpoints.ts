/**
 * Endpoints de SUNAT permitidos. LISTA BLANCA: la URL sale de la configuración de un negocio y un servicio que firma
 * documentos tributarios no debe poder apuntarse a cualquier sitio.
 *
 * ⚠️ Las dos direcciones de SUNAT son de memoria y SIN verificar en la documentación oficial vigente. Se confirman
 * antes del primer envío al ambiente beta. Cambiarlas aquí cambia lo que el sistema acepta.
 */
export const SUNAT_BETA_BILL = 'https://e-beta.sunat.gob.pe/ol-ti-itcpfegem-beta/billService'
export const SUNAT_PRODUCCION_BILL = 'https://e-factura.sunat.gob.pe/ol-ti-itcpfegem/billService'
/** ⚠️ Servicio de consulta de CDR en BETA: de una biblioteca de terceros (NO de SUNAT) y sin confirmar en BETA real. Es otra aplicación que el envío (`ol-it-wsconscpegem`, no `ol-ti-itcpfegem-beta`). */
export const SUNAT_BETA_CONSULTA = 'https://e-beta.sunat.gob.pe/ol-it-wsconscpegem/billConsultService'
export const SUNAT_PRODUCCION_CONSULTA = 'https://e-factura.sunat.gob.pe/ol-it-wsconscpegem/billConsultService'

export type TipoEndpointSunat = 'beta' | 'produccion' | 'falso'

export interface VeredictoEndpoint {
  ok: boolean
  tipo: TipoEndpointSunat | null
  motivo: string
}

const HOSTS: Record<string, 'beta' | 'produccion'> = {
  'e-beta.sunat.gob.pe': 'beta',
  'e-factura.sunat.gob.pe': 'produccion',
}

const esProduccionDeLaApp = (env: Record<string, string | undefined>) =>
  env.VERCEL_ENV === 'production' || env.NODE_ENV === 'production'

/**
 * Los únicos destinos válidos: los dos hosts de SUNAT (https) y, SOLO fuera de producción, un servidor local de
 * pruebas (`localhost` / `127.0.0.1`). El SUNAT falso no puede usarse en producción aunque alguien escriba su URL.
 */
export function evaluarEndpointSunat(url: string | undefined | null, env: Record<string, string | undefined> = process.env): VeredictoEndpoint {
  if (!url) return { ok: false, tipo: null, motivo: 'No hay URL del servicio de SUNAT.' }
  let u: URL
  try { u = new URL(url) } catch { return { ok: false, tipo: null, motivo: 'La URL del servicio de SUNAT no se puede interpretar.' } }
  if (u.username || u.password) return { ok: false, tipo: null, motivo: 'La URL no puede llevar usuario ni clave.' }

  const host = u.hostname.toLowerCase()
  // Solo el puerto normal de https: un puerto raro en un host de SUNAT no es el servicio de comprobantes.
  if (u.protocol === 'https:' && HOSTS[host]) {
    if (u.port !== '') return { ok: false, tipo: null, motivo: 'La URL de SUNAT no puede llevar un puerto distinto del normal.' }
    return { ok: true, tipo: HOSTS[host]!, motivo: `host ${host}` }
  }

  if ((host === 'localhost' || host === '127.0.0.1') && u.protocol === 'http:') {
    if (esProduccionDeLaApp(env)) {
      return { ok: false, tipo: null, motivo: 'El SUNAT falso (servidor local) no se puede usar en producción.' }
    }
    return { ok: true, tipo: 'falso', motivo: 'servidor local de pruebas (SUNAT falso)' }
  }
  return { ok: false, tipo: null, motivo: `El host ${host} no es un servicio de SUNAT permitido.` }
}

/** URL del servicio de consulta de CDR a partir de la de envío. */
export function urlConsulta(urlBill: string): string {
  if (urlBill === SUNAT_PRODUCCION_BILL) return SUNAT_PRODUCCION_CONSULTA
  if (urlBill === SUNAT_BETA_BILL) return SUNAT_BETA_CONSULTA
  return urlBill.replace(/\/billService$/, '/billConsultService')
}
