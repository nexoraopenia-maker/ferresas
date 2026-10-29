import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { verificarFirmaXml } from '../../src/features/sunat/firma'
import { crearZip, leerZip } from '../../src/features/sunat/zip'
import { crearZipEstiloSunat } from './zip-sunat'

/**
 * SUNAT FALSO. Servidor HTTP de pruebas que imita el servicio SOAP de comprobantes. Vive en `tests/`: NO es una ruta de la
 * aplicación y no se despliega.
 *
 * ─── LO QUE DEMUESTRA Y LO QUE NO ────────────────────────────────────────────────────────────────
 * Ejercita NUESTRA mecánica: sobre SOAP, ZIP, firma (la verifica de verdad con criptografía), lectura del CDR, mapeo de
 * estados, reintentos e idempotencia. NO demuestra que SUNAT acepte nuestro XML ni nuestros catálogos: lo escribimos
 * nosotros a partir de lo que entendemos. Los CÓDIGOS que devuelve (0102, 0109, 0151, 0306, 0127, 1033, 3030…) son
 * ⚠️ NO VERIFICADOS: sirven para recorrer los rangos que nuestro código clasifica, no para afirmar que SUNAT los use así.
 * Ningún ⚠️ de docs/COMPLIANCE.md se quita con este falso.
 */

export type Escenario =
  | 'ok' | 'observado' | 'rechazo' | 'auth' | 'servidor' | 'http500' | 'ilegible' | 'sin_cdr' | 'lento'
  /** sendSummary: error de contenido del resumen (⚠️ código no verificado). */
  | 'invalido'
  /** El CDR viaja como lo hace SUNAT BETA real: ZIP con carpeta `dummy/` y descriptor de datos (hallazgo #33). */
  | 'zip_sunat'

export interface SolicitudRecibida {
  operacion: string
  ruta: string
  usuario: string
  clave: string
  nombreZip?: string
  /** XML dentro del ZIP (sendBill / sendSummary). */
  xml?: string
  /** La firma del XML verifica con el certificado que trae. */
  firmaValida?: boolean
}

export interface SunatFalso {
  url: string
  urlConsulta: string
  recibidas: SolicitudRecibida[]
  /** Escenarios para las próximas peticiones (de cualquiera), en orden; sin ellos, 'ok'. */
  guion: Escenario[]
  /** Escenarios para las próximas peticiones de UN RUC (no los consumen las de otros negocios de una base compartida). */
  programar(ruc: string, ...escenarios: Escenario[]): void
  /** Usuarios aceptados (RUC + usuario SOL → clave); se pueden añadir con el servidor en marcha. */
  usuarios: Record<string, string>
  detener(): Promise<void>
}

const NS = 'xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"'

const cdrXml = (ref: string, codigo: string, descripcion: string, notas: string[] = []) =>
  `<?xml version="1.0" encoding="UTF-8"?><ar:ApplicationResponse xmlns:ar="urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2" ${NS}>` +
  `<cbc:ID>${Date.now()}</cbc:ID><cbc:ResponseDate>2026-10-24</cbc:ResponseDate>` +
  notas.map((n) => `<cbc:Note>${n}</cbc:Note>`).join('') +
  `<cac:DocumentResponse><cac:Response><cbc:ReferenceID>${ref}</cbc:ReferenceID><cbc:ResponseCode>${codigo}</cbc:ResponseCode>` +
  `<cbc:Description>${descripcion}</cbc:Description></cac:Response></cac:DocumentResponse></ar:ApplicationResponse>`

const sobreOk = (cuerpo: string) =>
  `<?xml version="1.0"?><soap-env:Envelope xmlns:soap-env="http://schemas.xmlsoap.org/soap/envelope/"><soap-env:Body>${cuerpo}</soap-env:Body></soap-env:Envelope>`
const fallo = (origen: 'Client' | 'Server', codigo: string, mensaje: string) =>
  sobreOk(`<soap-env:Fault><faultcode>soap-env:${origen}.${codigo}</faultcode><faultstring>${mensaje}</faultstring></soap-env:Fault>`)
let zipEstiloSunat = false
const zipDeCdr = (base: string, xml: string) => (zipEstiloSunat ? crearZipEstiloSunat(`dummy/R-${base}.xml`, Buffer.from(xml, 'utf8')) : crearZip(`R-${base}.xml`, Buffer.from(xml, 'utf8'))).toString('base64')

const tag = (x: string, n: string) => new RegExp(`<(?:[\\w-]+:)?${n}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${n}>`).exec(x)?.[1]
const NOMBRE = /^(\d{11})-(\d{2})-([A-Z0-9]{4})-(\d+)\.zip$/
/** ⚠️ Nombre del resumen diario (RC) o de la comunicación de baja (RA): RUC-RC|RA-AAAAMMDD-N (supuesto). */
const NOMBRE_RESUMEN = /^(\d{11})-(?:RC|RA)-(\d{8})-(\d+)\.zip$/

export async function iniciarSunatFalso(o: { usuarios?: Record<string, string>; guion?: Escenario[]; demoraMs?: number } = {}): Promise<SunatFalso> {
  const usuarios = o.usuarios ?? { '20123456789MODDATOS': 'moddatos' }
  const recibidas: SolicitudRecibida[] = []
  const guion: Escenario[] = [...(o.guion ?? [])]
  const guionPorRuc = new Map<string, Escenario[]>()
  const comprobantes = new Map<string, { hash: string; cdr: string }>() // base → contenido y CDR ya devuelto
  const resumenes = new Map<string, { consultas: number; cdr: string }>()
  const ticketsPorArchivo = new Map<string, { hash: string; ticket: string }>() // idempotencia del resumen
  let seq = 0

  const servidor: Server = createServer((req, res) => {
    const partes: Buffer[] = []
    let total = 0
    req.on('data', (b: Buffer) => { total += b.length; if (total <= 4_000_000) partes.push(b) })
    req.on('end', async () => {
      const cuerpo = Buffer.concat(partes).toString('utf8')
      const enviar = (estado: number, texto: string) => { res.writeHead(estado, { 'Content-Type': 'text/xml; charset=utf-8' }); res.end(texto) }

      const op = /<(?:ser:)?(sendBill|sendSummary|getStatus|getStatusCdr)\b/.exec(cuerpo)?.[1] ?? 'desconocida'
      const usuario = tag(cuerpo, 'Username') ?? '', clave = tag(cuerpo, 'Password') ?? ''
      const s: SolicitudRecibida = { operacion: op, ruta: req.url ?? '', usuario, clave }
      recibidas.push(s)

      const escenario = guionPorRuc.get(usuario.slice(0, 11))?.shift() ?? guion.shift() ?? 'ok'
      zipEstiloSunat = escenario === 'zip_sunat'
      if (escenario === 'lento') await new Promise((r) => setTimeout(r, o.demoraMs ?? 400))
      if (escenario === 'http500') return enviar(500, 'Internal Server Error')
      if (escenario === 'servidor') return enviar(500, fallo('Server', '0109', 'El servicio de SUNAT no está disponible'))
      if (escenario === 'ilegible') return enviar(200, '<html>esto no es SOAP</html>')
      if (escenario === 'auth' || usuarios[usuario] !== clave) return enviar(500, fallo('Client', '0102', 'El usuario o contraseña es incorrecto'))

      if (op === 'sendBill' || op === 'sendSummary') {
        const nombreZip = tag(cuerpo, 'fileName') ?? ''
        s.nombreZip = nombreZip
        const m = op === 'sendSummary' ? NOMBRE_RESUMEN.exec(nombreZip) : NOMBRE.exec(nombreZip)
        if (!m) return enviar(500, fallo('Client', '0151', 'El nombre del archivo ZIP es incorrecto'))
        let xml: string
        try {
          const e = leerZip(Buffer.from(tag(cuerpo, 'contentFile') ?? '', 'base64'))
          const interno = e.find((x) => x.nombre === nombreZip.replace(/\.zip$/, '.xml'))
          if (!interno) return enviar(500, fallo('Client', '0152', 'El ZIP no contiene el XML con el nombre esperado'))
          xml = interno.contenido.toString('utf8')
        } catch { return enviar(500, fallo('Client', '0153', 'El archivo ZIP está dañado')) }
        s.xml = xml
        const base = nombreZip.replace(/\.zip$/, '')

        if (op === 'sendSummary') {
          s.firmaValida = verificarFirmaXml(xml).valida
          if (!s.firmaValida) return enviar(500, fallo('Client', '0306', 'La firma digital del XML no es válida'))
          if (escenario === 'invalido') return enviar(500, fallo('Client', '0305', 'El resumen no cumple la estructura esperada (falso)'))
          const hashR = createHash('sha256').update(xml).digest('hex')
          const previo = ticketsPorArchivo.get(base)
          if (previo && previo.hash !== hashR) return enviar(500, fallo('Client', '1033', 'El resumen fue registrado previamente con otros datos'))
          const ticket = previo?.ticket ?? `${Date.now()}${++seq}`
          if (!previo) {
            ticketsPorArchivo.set(base, { hash: hashR, ticket })
            const cdr = escenario === 'rechazo' ? cdrXml(base, '3030', `El resumen ${base} fue rechazado (falso)`)
              : escenario === 'observado' ? cdrXml(base, '0', `El resumen ${base} ha sido aceptado`, ['4252 - Observación de prueba (falso)'])
              : cdrXml(base, '0', `El resumen ${base} ha sido aceptado`)
            resumenes.set(ticket, { consultas: 0, cdr })
          }
          return enviar(200, sobreOk(`<ns2:sendSummaryResponse xmlns:ns2="http://service.sunat.gob.pe"><ticket>${ticket}</ticket></ns2:sendSummaryResponse>`))
        }

        s.firmaValida = verificarFirmaXml(xml).valida
        if (!s.firmaValida) return enviar(500, fallo('Client', '0306', 'La firma digital del XML no es válida'))
        const hash = createHash('sha256').update(xml).digest('hex')
        const previo = comprobantes.get(base)
        if (previo && previo.hash !== hash) return enviar(500, fallo('Client', '1033', 'El comprobante fue registrado previamente con otros datos'))

        const ref = `${m[3]}-${m[4]}`
        let cdr = previo?.cdr
        if (!cdr) {
          cdr = escenario === 'rechazo' ? cdrXml(ref, '3030', `El comprobante ${ref} fue rechazado (falso)`)
            : escenario === 'observado' ? cdrXml(ref, '0', `El comprobante ${ref} ha sido aceptado`, ['4252 - Observación de prueba (falso)'])
            : cdrXml(ref, '0', `El comprobante ${ref}, ha sido aceptado`)
          comprobantes.set(base, { hash, cdr })
        }
        if (escenario === 'sin_cdr') return enviar(200, sobreOk('<ns2:sendBillResponse xmlns:ns2="http://service.sunat.gob.pe"><applicationResponse></applicationResponse></ns2:sendBillResponse>'))
        return enviar(200, sobreOk(`<ns2:sendBillResponse xmlns:ns2="http://service.sunat.gob.pe"><applicationResponse>${zipDeCdr(base, cdr)}</applicationResponse></ns2:sendBillResponse>`))
      }

      if (op === 'getStatusCdr') {
        const base = `${tag(cuerpo, 'rucComprobante')}-${tag(cuerpo, 'tipoComprobante')}-${tag(cuerpo, 'serieComprobante')}-${tag(cuerpo, 'numeroComprobante')}`
        const c = comprobantes.get(base)
        if (!c) return enviar(500, fallo('Client', '0127', 'El comprobante no existe en SUNAT'))
        return enviar(200, sobreOk(`<ns2:getStatusCdrResponse xmlns:ns2="http://service.sunat.gob.pe"><statusCdr><content>${zipDeCdr(base, c.cdr)}</content><statusCode>0004</statusCode></statusCdr></ns2:getStatusCdrResponse>`))
      }

      if (op === 'getStatus') {
        const t = resumenes.get(tag(cuerpo, 'ticket') ?? '')
        if (!t) return enviar(500, fallo('Client', '0127', 'El ticket no existe'))
        t.consultas++
        // La primera consulta: en proceso (98). La siguiente: terminó (0) con su CDR.
        if (t.consultas === 1) return enviar(200, sobreOk('<ns2:getStatusResponse xmlns:ns2="http://service.sunat.gob.pe"><status><statusCode>98</statusCode></status></ns2:getStatusResponse>'))
        return enviar(200, sobreOk(`<ns2:getStatusResponse xmlns:ns2="http://service.sunat.gob.pe"><status><content>${zipDeCdr('resumen', t.cdr)}</content><statusCode>0</statusCode></status></ns2:getStatusResponse>`))
      }
      enviar(500, fallo('Client', '0100', 'Operación desconocida'))
    })
  })

  await new Promise<void>((r) => servidor.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`
  return {
    url: `${url}/billService`, urlConsulta: `${url}/billConsultService`, recibidas, guion,
    usuarios,
    programar: (ruc, ...e) => { guionPorRuc.set(ruc, [...(guionPorRuc.get(ruc) ?? []), ...e]) },
    detener: () => new Promise((r) => { servidor.closeAllConnections(); servidor.close(() => r()) }),
  }
}
