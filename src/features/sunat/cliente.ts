import { leerCdr, CdrIlegible, categoriaDeCodigo, type Cdr, type CategoriaCodigo } from './cdr'
import { escaparXml, estadoDeTicket, leerFallo, sobreGetStatus, sobreGetStatusCdr, sobreSendBill, sobreSendSummary, ticketDe, xmlDelCdr, type FalloSoap } from './soap'
import { crearZip, ZipInvalido } from './zip'
import { evaluarEndpointSunat, urlConsulta } from './endpoints'

/**
 * Cliente de los servicios web de SUNAT: empaqueta, envía, y devuelve un resultado ya clasificado.
 *
 * No decide estados de negocio (eso lo hace el proveedor): solo dice QUÉ pasó, sin ambigüedad:
 *   · `cdr`: SUNAT respondió con una constancia (aceptado, observado o rechazado según el código);
 *   · `fallo`: SUNAT respondió con un fallo SOAP (acceso, contenido o servidor);
 *   · `transitorio`: no hubo respuesta utilizable (red, tiempo agotado, 5xx, respuesta ilegible). Reintentar es seguro.
 *
 * Una respuesta 2xx que no se puede interpretar NUNCA es un éxito.
 */

export interface CredencialesSol {
  /** RUC del contribuyente. */
  ruc: string
  /** Usuario SOL SECUNDARIO (nunca el principal). */
  usuarioSol: string
  claveSol: string
}

export interface DepsCliente {
  fetch?: typeof fetch
  timeoutMs?: number
  env?: Record<string, string | undefined>
}

export type ResultadoSunat =
  | { tipo: 'cdr'; cdr: Cdr; categoria: CategoriaCodigo; xmlCdr: string }
  | { tipo: 'ticket'; ticket: string }
  | { tipo: 'fallo'; fallo: FalloSoap; categoria: CategoriaCodigo | 'servidor' }
  | { tipo: 'transitorio'; mensaje: string }

export class EndpointNoPermitido extends Error {
  constructor(motivo: string) { super(motivo); this.name = 'EndpointNoPermitido' }
}

const TIMEOUT_MS = 15_000
const MAX_RESPUESTA = 1024 * 1024

async function llamar(url: string, sobre: string, d: DepsCliente, accion = ''): Promise<{ estado: number; cuerpo: string } | { transitorio: string }> {
  const v = evaluarEndpointSunat(url, d.env)
  if (!v.ok) throw new EndpointNoPermitido(v.motivo)
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), d.timeoutMs ?? TIMEOUT_MS)
  try {
    const r = await (d.fetch ?? fetch)(url, {
      method: 'POST', redirect: 'manual', signal: ctl.signal,
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: accion },
      body: sobre,
    })
    // El tope se aplica MIENTRAS se lee: una respuesta enorme no se carga entera en memoria para luego rechazarla.
    const declarado = Number(r.headers.get('content-length'))
    if (Number.isFinite(declarado) && declarado > MAX_RESPUESTA) { await r.body?.cancel().catch(() => undefined); return { transitorio: 'La respuesta de SUNAT es demasiado grande.' } }
    const trozos: Buffer[] = []
    let total = 0
    if (r.body) {
      const lector = r.body.getReader()
      for (;;) {
        const { done, value } = await lector.read()
        if (done) break
        total += value.byteLength
        if (total > MAX_RESPUESTA) { await lector.cancel().catch(() => undefined); return { transitorio: 'La respuesta de SUNAT es demasiado grande.' } }
        trozos.push(Buffer.from(value))
      }
    }
    return { estado: r.status, cuerpo: Buffer.concat(trozos).toString('utf8') }
  } catch (e) {
    return { transitorio: (e as Error).name === 'AbortError' ? 'SUNAT no respondió a tiempo.' : 'No se pudo conectar con SUNAT.' }
  } finally {
    clearTimeout(t)
  }
}

/** Clasifica la respuesta de una operación que devuelve un CDR (sendBill, getStatusCdr). */
function clasificarCdr(r: { estado: number; cuerpo: string } | { transitorio: string }): ResultadoSunat {
  if ('transitorio' in r) return { tipo: 'transitorio', mensaje: r.transitorio }
  // Un fallo SOAP llega con 500: se lee ANTES de tratar el 5xx como caída.
  const fallo = leerFallo(r.cuerpo)
  if (fallo) {
    // Un fallo del lado del servidor (no del cliente) es transitorio: reintentar es seguro.
    if (fallo.origen === 'Server') return { tipo: 'transitorio', mensaje: fallo.mensaje }
    return { tipo: 'fallo', fallo, categoria: fallo.codigo ? categoriaDeCodigo(fallo.codigo) : 'excepcion' }
  }
  if (r.estado >= 300) return { tipo: 'transitorio', mensaje: `SUNAT respondió HTTP ${r.estado}.` }
  try {
    const xml = xmlDelCdr(r.cuerpo)
    if (!xml) return { tipo: 'transitorio', mensaje: 'SUNAT respondió sin CDR.' }
    const cdr = leerCdr(xml)
    return { tipo: 'cdr', cdr, categoria: categoriaDeCodigo(cdr.codigo), xmlCdr: xml }
  } catch (e) {
    if (e instanceof CdrIlegible || e instanceof ZipInvalido) return { tipo: 'transitorio', mensaje: 'La respuesta de SUNAT no se pudo interpretar.' }
    throw e
  }
}

/** Nombre del archivo: `RUC-TT-SERIE-CORRELATIVO` (⚠️ forma de memoria, sin verificar). */
export const nombreBase = (ruc: string, tipo: string, serie: string, correlativo: number) => `${ruc}-${tipo}-${serie}-${correlativo}`

export async function enviarComprobante(
  url: string, cred: CredencialesSol, base: string, xmlFirmado: string, d: DepsCliente = {},
): Promise<ResultadoSunat> {
  const zip = crearZip(`${base}.xml`, Buffer.from(xmlFirmado, 'utf8'))
  const sobre = sobreSendBill(`${cred.ruc}${cred.usuarioSol}`, cred.claveSol, `${base}.zip`, zip.toString('base64'))
  return clasificarCdr(await llamar(url, sobre, d))
}

export async function consultarCdr(
  urlBill: string, cred: CredencialesSol, ref: { tipo: string; serie: string; numero: number }, d: DepsCliente = {},
): Promise<ResultadoSunat> {
  const sobre = sobreGetStatusCdr(`${cred.ruc}${cred.usuarioSol}`, cred.claveSol, { ruc: cred.ruc, tipo: ref.tipo, serie: ref.serie, numero: ref.numero })
  // ⚠️ SOAPAction `urn:getStatusCdr` y la URL de consulta salen de ejemplos de terceros, no de SUNAT (docs/SUNAT-SUPUESTOS.md #35).
  return clasificarCdr(await llamar(urlConsulta(urlBill), sobre, d, 'urn:getStatusCdr'))
}

/** Resumen diario / comunicación de baja: devuelve un ticket (fase 1B.5). */
export async function enviarResumen(
  url: string, cred: CredencialesSol, base: string, xml: string, d: DepsCliente = {},
): Promise<ResultadoSunat> {
  const zip = crearZip(`${base}.xml`, Buffer.from(xml, 'utf8'))
  const r = await llamar(url, sobreSendSummary(`${cred.ruc}${cred.usuarioSol}`, cred.claveSol, `${base}.zip`, zip.toString('base64')), d)
  if ('transitorio' in r) return { tipo: 'transitorio', mensaje: r.transitorio }
  const fallo = leerFallo(r.cuerpo)
  if (fallo) return fallo.origen === 'Server' ? { tipo: 'transitorio', mensaje: fallo.mensaje } : { tipo: 'fallo', fallo, categoria: fallo.codigo ? categoriaDeCodigo(fallo.codigo) : 'excepcion' }
  const ticket = ticketDe(r.cuerpo)
  return ticket && r.estado < 300 ? { tipo: 'ticket', ticket } : { tipo: 'transitorio', mensaje: 'SUNAT respondió sin ticket.' }
}

export async function consultarTicket(
  url: string, cred: CredencialesSol, ticket: string, d: DepsCliente = {},
): Promise<ResultadoSunat | { tipo: 'en_proceso' }> {
  const r = await llamar(url, sobreGetStatus(`${cred.ruc}${cred.usuarioSol}`, cred.claveSol, ticket), d)
  if ('transitorio' in r) return { tipo: 'transitorio', mensaje: r.transitorio }
  const fallo = leerFallo(r.cuerpo)
  if (fallo) return fallo.origen === 'Server' ? { tipo: 'transitorio', mensaje: fallo.mensaje } : { tipo: 'fallo', fallo, categoria: fallo.codigo ? categoriaDeCodigo(fallo.codigo) : 'excepcion' }
  const { codigo, xmlCdr } = estadoDeTicket(r.cuerpo)
  // ⚠️ Código de estado del ticket (0 = terminó, 98 = en proceso, 99 = terminó con error): de memoria, sin verificar.
  if (codigo === '98') return { tipo: 'en_proceso' }
  if (!xmlCdr) return { tipo: 'transitorio', mensaje: 'SUNAT respondió el ticket sin CDR.' }
  try {
    const cdr = leerCdr(xmlCdr)
    return { tipo: 'cdr', cdr, categoria: categoriaDeCodigo(cdr.codigo), xmlCdr }
  } catch { return { tipo: 'transitorio', mensaje: 'La respuesta de SUNAT no se pudo interpretar.' } }
}

export { escaparXml }
