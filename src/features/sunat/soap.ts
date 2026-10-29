import { leerZip } from './zip'

/**
 * Sobres SOAP del servicio de comprobantes de SUNAT y lectura de sus respuestas.
 *
 * ⚠️ SIN VALIDAR CONTRA EL SERVICIO REAL: el espacio de nombres (`http://service.sunat.gob.pe`), los nombres de las
 * operaciones (`sendBill`, `getStatusCdr`, `sendSummary`, `getStatus`), la autenticación con `UsernameToken` (usuario =
 * RUC + usuario SOL secundario) y la forma de los fallos salen de lo que entendemos de la documentación de SUNAT.
 * Se confirman con el ambiente beta.
 */

const NS_SERVICIO = 'http://service.sunat.gob.pe'

export const escaparXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

function sobre(usuario: string, clave: string, cuerpo: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ser="${NS_SERVICIO}" ` +
    `xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">` +
    `<soapenv:Header><wsse:Security><wsse:UsernameToken>` +
    `<wsse:Username>${escaparXml(usuario)}</wsse:Username><wsse:Password>${escaparXml(clave)}</wsse:Password>` +
    `</wsse:UsernameToken></wsse:Security></soapenv:Header><soapenv:Body>${cuerpo}</soapenv:Body></soapenv:Envelope>`
  )
}

export const sobreSendBill = (u: string, c: string, nombreZip: string, zipBase64: string) =>
  sobre(u, c, `<ser:sendBill><fileName>${escaparXml(nombreZip)}</fileName><contentFile>${zipBase64}</contentFile></ser:sendBill>`)

export const sobreSendSummary = (u: string, c: string, nombreZip: string, zipBase64: string) =>
  sobre(u, c, `<ser:sendSummary><fileName>${escaparXml(nombreZip)}</fileName><contentFile>${zipBase64}</contentFile></ser:sendSummary>`)

export const sobreGetStatus = (u: string, c: string, ticket: string) =>
  sobre(u, c, `<ser:getStatus><ticket>${escaparXml(ticket)}</ticket></ser:getStatus>`)

export const sobreGetStatusCdr = (u: string, c: string, d: { ruc: string; tipo: string; serie: string; numero: number }) =>
  sobre(u, c, `<ser:getStatusCdr><rucComprobante>${escaparXml(d.ruc)}</rucComprobante><tipoComprobante>${escaparXml(d.tipo)}</tipoComprobante>` +
    `<serieComprobante>${escaparXml(d.serie)}</serieComprobante><numeroComprobante>${d.numero}</numeroComprobante></ser:getStatusCdr>`)

// ─── Lectura de respuestas ────────────────────────────────────────────────────────────────────────────

const tag = (xml: string, nombre: string) =>
  new RegExp(`<(?:[A-Za-z0-9_-]+:)?${nombre}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_-]+:)?${nombre}>`).exec(xml)?.[1]
const texto = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim()

export interface FalloSoap {
  /** Código de SUNAT dentro del fallo, p. ej. "0102" (de `faultcode` tipo `soap-env:Client.0102` o del detalle). */
  codigo: string | null
  /** `Client` o `Server`. */
  origen: 'Client' | 'Server' | null
  mensaje: string
}

/** Un fallo SOAP, o `null` si la respuesta no es un fallo. */
export function leerFallo(xml: string): FalloSoap | null {
  const fault = tag(xml, 'Fault')
  if (fault === undefined) return null
  const faultcode = texto(tag(fault, 'faultcode') ?? '')
  const mensaje = texto(tag(fault, 'faultstring') ?? '') || 'Error del servicio de SUNAT.'
  const detalle = texto(tag(fault, 'message') ?? tag(fault, 'detail') ?? '')
  const codigo = /(?:\.|^)(\d{3,5})$/.exec(faultcode)?.[1] ?? /\b(\d{4})\b/.exec(detalle)?.[1] ?? null
  const origen = /Server/i.test(faultcode) ? 'Server' : /Client/i.test(faultcode) ? 'Client' : null
  return { codigo, origen, mensaje: detalle && !mensaje.includes(detalle) ? `${mensaje} (${detalle})` : mensaje }
}

/** El ZIP del CDR de una respuesta `sendBill` / `getStatusCdr` → el XML del CDR. `null` si no trae. */
export function xmlDelCdr(respuesta: string): string | null {
  const b64 = tag(respuesta, 'applicationResponse') ?? tag(respuesta, 'content')
  if (!b64 || !texto(b64)) return null
  const entradas = leerZip(Buffer.from(texto(b64), 'base64'))
  const cdr = entradas.find((e) => e.nombre.toLowerCase().endsWith('.xml'))
  return cdr ? cdr.contenido.toString('utf8') : null
}

export const ticketDe = (respuesta: string): string | null => {
  const t = tag(respuesta, 'ticket')
  return t ? texto(t) : null
}

export const estadoDeTicket = (respuesta: string): { codigo: string | null; xmlCdr: string | null } => ({
  codigo: ((): string | null => { const s = tag(respuesta, 'statusCode'); return s ? texto(s) : null })(),
  xmlCdr: xmlDelCdr(respuesta),
})
