import { construirXmlUbl } from '@/features/invoicing/ubl'
import { ErrorConfiguracionProveedor } from '@/features/invoicing/providers/errores'
import type {
  CredencialesProveedor, ConsultaBaja, Descarga, EnvioBaja, EstadoComprobante, FormatoDescarga, ProveedorFacturacion, ResultadoBaja, ResultadoEmision,
} from '@/features/invoicing/providers/types'
import { CertificadoInvalido, estadoCertificado, leerPfx, type CertificadoCargado } from './certificado'
import { esFalloDeAcceso } from './cdr'
import { consultarCdr, consultarTicket, enviarComprobante, enviarResumen, nombreBase, type CredencialesSol, type DepsCliente, type ResultadoSunat } from './cliente'
import { evaluarEndpointSunat } from './endpoints'
import { construirXmlBaja } from './baja-xml'
import { firmarXml, type AlgoritmoFirma } from './firma'

/**
 * Proveedor `sunat-directo` (S3): FerreSaaS firma el XML y lo envía a los servicios web de SUNAT (SEE-Del Contribuyente), sin intermediario. Implementa la misma
 * interfaz que el resto de proveedores: la cola, los estados y las pantallas no cambian.
 *
 * ⚠️ TODO lo de esta vía está SIN validar contra SUNAT (ver `docs/SUNAT-SUPUESTOS.md`). Se probó contra un SUNAT falso que escribimos nosotros: eso demuestra
 * NUESTRA mecánica, no que SUNAT acepte el XML.
 *
 * Reglas:
 *  · Un problema de acceso o de configuración (usuario, clave, certificado vencido o ajeno) NO es un rechazo del comprobante: se lanza `ErrorConfiguracionProveedor`
 *    y el comprobante no cambia de estado.
 *  · Sin respuesta utilizable (red, tiempo, 5xx, ilegible) → PENDIENTE y reintentable; JAMÁS aceptado.
 *  · Un rechazo de fondo es definitivo (reintentar el mismo XML da el mismo rechazo).
 *  · Facturas, boletas y notas de crédito van por el MISMO envío (`sendBill`): las boletas se envían una por una (decisión del dueño; ⚠️ el contador lo confirma).
 *  · Se devuelven los archivos fiscales: el XML tal como se firmó y se envió, y el CDR de SUNAT.
 */

export interface DepsProveedor extends DepsCliente {
  algoritmo?: AlgoritmoFirma
  ahora?: () => Date
}

export interface Preparado {
  cert: CertificadoCargado
  url: string
  sol: CredencialesSol
}

export function preparar(c: CredencialesProveedor, ruc: string, d: DepsProveedor): Preparado {
  if (!c.usuarioSol || !c.claveSol) throw new ErrorConfiguracionProveedor('Faltan el usuario y la clave SOL secundarios del negocio.')
  if (!c.certificadoBase64 || !c.claveCertificado) throw new ErrorConfiguracionProveedor('Falta el certificado digital (.pfx) del negocio o su clave.')
  const v = evaluarEndpointSunat(c.urlBase, d.env)
  if (!v.ok) throw new ErrorConfiguracionProveedor(v.motivo)

  let cert: CertificadoCargado
  try { cert = leerPfx(Buffer.from(c.certificadoBase64, 'base64'), c.claveCertificado) } catch (e) {
    if (e instanceof CertificadoInvalido) throw new ErrorConfiguracionProveedor(e.message)
    throw e
  }
  const estado = estadoCertificado(cert, d.ahora?.() ?? new Date())
  if (estado === 'vencido') throw new ErrorConfiguracionProveedor('El certificado digital del negocio está vencido: renuévalo para poder emitir.')
  if (estado === 'aun_no_vigente') throw new ErrorConfiguracionProveedor('El certificado digital del negocio todavía no está vigente.')
  // ⚠️ El RUC del titular se deduce del sujeto (heurística): si se detecta y no coincide, es un certificado ajeno.
  if (cert.ruc && cert.ruc !== ruc) throw new ErrorConfiguracionProveedor('El certificado digital no corresponde al RUC del negocio.')
  return { cert, url: c.urlBase!, sol: { ruc, usuarioSol: c.usuarioSol, claveSol: c.claveSol } }
}

const unir = (...partes: (string | undefined)[]) => partes.filter(Boolean).join(' · ')

/** SUNAT respondió: lo traducimos a nuestro resultado, con los archivos fiscales que correspondan. */
function aEmision(r: ResultadoSunat, base: string, hashXml: string, xmlFirmado: string): ResultadoEmision {
  switch (r.tipo) {
    case 'transitorio':
      // No hubo respuesta: no se guarda nada (el XML se vuelve a firmar en el reintento).
      return { estado: 'PENDIENTE', idExterno: null, ticket: null, codigoRespuesta: null, mensaje: r.mensaje, hashXml: null, reintentable: true }
    case 'ticket':
      return { estado: 'ENVIADO', idExterno: base, ticket: r.ticket, codigoRespuesta: null, mensaje: 'Recibido por SUNAT; falta su constancia.', hashXml, archivos: { xmlFirmado }, reintentable: false }
    case 'fallo':
      // Solo un fallo de ACCESO (⚠️ 0101–0106) es de configuración; los demás 01xx (p. ej. un nombre de archivo mal formado) son del contenido y se corrigen emitiendo de nuevo.
      if (esFalloDeAcceso(r.fallo.codigo)) throw new ErrorConfiguracionProveedor(`SUNAT rechazó el acceso: ${r.fallo.mensaje}`)
      // El rechazo por fallo SOAP no trae CDR; sí se conserva lo que se envió.
      return { estado: 'RECHAZADO', idExterno: null, ticket: null, codigoRespuesta: r.fallo.codigo, mensaje: r.fallo.mensaje, hashXml: null, archivos: { xmlFirmado }, reintentable: false }
    case 'cdr': {
      const comun = { idExterno: base, ticket: null, codigoRespuesta: r.cdr.codigo, reintentable: false, archivos: { xmlFirmado, cdrXml: r.xmlCdr } }
      // ⚠️ «Aceptado con observaciones» = código 0 acompañado de notas (advertencias): lo entendemos así, sin verificar.
      if (r.categoria === 'aceptado' && r.cdr.notas.length === 0) return { ...comun, estado: 'ACEPTADO', mensaje: r.cdr.descripcion, hashXml }
      if (r.categoria === 'aceptado' || r.categoria === 'observado') return { ...comun, estado: 'OBSERVADO', mensaje: unir(r.cdr.descripcion, ...r.cdr.notas), hashXml }
      if (esFalloDeAcceso(r.cdr.codigo)) throw new ErrorConfiguracionProveedor(`SUNAT rechazó el acceso: ${r.cdr.descripcion}`)
      return { ...comun, estado: 'RECHAZADO', idExterno: null, mensaje: r.cdr.descripcion || `SUNAT rechazó el comprobante (${r.cdr.codigo}).`, hashXml: null }
    }
  }
}

export function crearProveedorSunatDirecto(d: DepsProveedor = {}): ProveedorFacturacion {
  return {
    nombre: 'sunat-directo',

    async emitir(comprobante, cred): Promise<ResultadoEmision> {
      const p = preparar(cred, comprobante.emisor.ruc, d)
      // El mismo camino que el envío real: construir, firmar, empaquetar, enviar. Si algo de esto lanza, no sale nada.
      const firmado = firmarXml(construirXmlUbl(comprobante), p.cert, { algoritmo: d.algoritmo })
      const base = nombreBase(comprobante.emisor.ruc, comprobante.tipoComprobante, comprobante.serie, comprobante.correlativo)
      return aEmision(await enviarComprobante(p.url, p.sol, base, firmado.xmlFirmado, d), base, firmado.digestValue, firmado.xmlFirmado)
    },

    async consultarEstado(ref, cred): Promise<EstadoComprobante> {
      // El identificador que guardamos al emitir ES el nombre base: RUC-TT-SERIE-CORRELATIVO.
      const m = /^(\d{11})-(\d{2})-([A-Z0-9]{4})-(\d+)$/.exec(ref.idExterno ?? '')
      if (!m) return { estado: 'ENVIADO', codigoRespuesta: null, mensaje: 'No hay identificador para consultar en SUNAT.', aceptadoEn: null }
      const p = preparar(cred, m[1]!, d)
      const r = await consultarCdr(p.url, p.sol, { tipo: m[2]!, serie: m[3]!, numero: Number(m[4]) }, d)
      if (r.tipo === 'cdr') {
        const estado = r.categoria === 'aceptado' ? (r.cdr.notas.length === 0 ? 'ACEPTADO' : 'OBSERVADO') : r.categoria === 'observado' ? 'OBSERVADO' : r.categoria === 'rechazado' ? 'RECHAZADO' : 'ENVIADO'
        return { estado, codigoRespuesta: r.cdr.codigo, mensaje: r.cdr.descripcion, aceptadoEn: null, cdrXml: r.xmlCdr }
      }
      // Una consulta que falla no cambia nada: sigue ENVIADO.
      return { estado: 'ENVIADO', codigoRespuesta: null, mensaje: r.tipo === 'fallo' ? r.fallo.mensaje : r.tipo === 'transitorio' ? r.mensaje : null, aceptadoEn: null }
    },

    // SUNAT da de baja en dos tiempos (ticket): ver `comunicarBaja` y `consultarBaja`. La baja de una sola llamada es de los proveedores simulados.
    async anular(): Promise<ResultadoBaja> {
      throw new ErrorConfiguracionProveedor('SUNAT recibe la baja en dos tiempos (comunicación y consulta del ticket): usa comunicarBaja.')
    },

    async comunicarBaja(solicitud, cred): Promise<EnvioBaja> {
      const p = preparar(cred, solicitud.emisor.ruc, d)
      const firmado = firmarXml(construirXmlBaja(solicitud), p.cert, { algoritmo: d.algoritmo })
      const r = await enviarResumen(p.url, p.sol, `${solicitud.emisor.ruc}-${solicitud.identificador}`, firmado.xmlFirmado, d)
      switch (r.tipo) {
        case 'ticket': return { tipo: 'ticket', ticket: r.ticket, xmlFirmado: firmado.xmlFirmado }
        case 'transitorio': return { tipo: 'transitorio', mensaje: r.mensaje }
        case 'fallo':
          if (esFalloDeAcceso(r.fallo.codigo)) throw new ErrorConfiguracionProveedor(`SUNAT rechazó el acceso: ${r.fallo.mensaje}`)
          return { tipo: 'rechazo', codigo: r.fallo.codigo, mensaje: r.fallo.mensaje, xmlFirmado: firmado.xmlFirmado }
        default: return { tipo: 'transitorio', mensaje: 'SUNAT respondió la comunicación de baja de un modo inesperado.' }
      }
    },

    async consultarBaja(ticket, rucEmisor, cred): Promise<ConsultaBaja> {
      const p = preparar(cred, rucEmisor, d)
      const r = await consultarTicket(p.url, p.sol, ticket, d)
      switch (r.tipo) {
        case 'en_proceso': return { tipo: 'en_proceso' }
        case 'cdr':
          // Un acceso denegado llega como fallo SOAP (rama de abajo), no como CDR.
          // ⚠️ Como en los comprobantes: código 0 = aceptada; las observaciones no la invalidan; un rechazo (2000–3999) no la acepta. Cualquier otro código tampoco.
          return { tipo: 'resuelta', aceptada: r.categoria === 'aceptado' || r.categoria === 'observado', codigo: r.cdr.codigo, mensaje: unir(r.cdr.descripcion, ...r.cdr.notas), cdrXml: r.xmlCdr }
        case 'fallo':
          if (esFalloDeAcceso(r.fallo.codigo)) throw new ErrorConfiguracionProveedor(`SUNAT rechazó el acceso: ${r.fallo.mensaje}`)
          // Un fallo al CONSULTAR no dice que la baja fue rechazada (p. ej. un ticket que aún no se ve): se vuelve a preguntar, nunca se da por rechazada.
          return { tipo: 'transitorio', mensaje: r.fallo.mensaje }
        case 'transitorio': return { tipo: 'transitorio', mensaje: r.mensaje }
        default: return { tipo: 'transitorio', mensaje: 'SUNAT respondió la consulta del ticket de un modo inesperado.' }
      }
    },

    // Los archivos fiscales no se piden al proveedor: ya se guardaron al enviar (`tax_document_files`) y se descargan desde ahí.
    async descargar(_ref, formato: FormatoDescarga): Promise<Descarga> {
      throw new ErrorConfiguracionProveedor(`La descarga de ${formato} sale de los archivos guardados del comprobante, no de SUNAT.`)
    },

    async verificarCredenciales(cred) {
      try {
        const v = evaluarEndpointSunat(cred.urlBase, d.env)
        if (!v.ok) return { ok: false, mensaje: v.motivo }
        if (!cred.usuarioSol || !cred.claveSol) return { ok: false, mensaje: 'Faltan el usuario y la clave SOL secundarios.' }
        if (!cred.certificadoBase64 || !cred.claveCertificado) return { ok: false, mensaje: 'Falta el certificado digital o su clave.' }
        const cert = leerPfx(Buffer.from(cred.certificadoBase64, 'base64'), cred.claveCertificado)
        const estado = estadoCertificado(cert, d.ahora?.() ?? new Date())
        const vence = cert.vence.toISOString().slice(0, 10)
        if (estado === 'vencido') return { ok: false, mensaje: 'El certificado está vencido.', certificadoVenceEn: vence }
        // Solo comprobaciones locales: no se emite ni se llama a SUNAT (eso es `probarConexionSunat`).
        return { ok: true, mensaje: estado === 'por_vencer' ? 'Certificado válido, pero vence pronto.' : 'Certificado válido.', certificadoVenceEn: vence }
      } catch (e) {
        return { ok: false, mensaje: e instanceof CertificadoInvalido ? e.message : 'No se pudieron comprobar las credenciales.' }
      }
    },
  }
}
