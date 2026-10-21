import { z } from 'zod'
import type { TaxDocumentStatus } from '@/generated/prisma/enums'
import { peticionHttp, type OpcionesHttp } from '@/lib/http-seguro'
import { validarUrlPse } from '../url-segura'
import { construirXmlUbl } from '../ubl'
import type {
  ComprobanteFiscal, CredencialesProveedor, Descarga, EstadoComprobante, FormatoDescarga,
  ProveedorFacturacion, ResultadoBaja, ResultadoEmision,
} from './types'

/**
 * Proveedor de facturación por REST (PSE que firma y envía a SUNAT).
 *
 * El PSE firma el XML con SU certificado y lo envía: el negocio no tramita ni
 * sube ningún .pfx. Este adaptador habla el contrato propio documentado en
 * `docs/PSE-CONTRATO.md` (JSON normalizado). Cada PSE comercial (Nubefact,
 * ApisPeru, Factiliza…) tiene su propio formato: conectar uno exige un PERFIL
 * que traduzca este contrato al suyo y se pruebe en SU ambiente de pruebas.
 *
 * ⚠️ NINGÚN perfil de un PSE comercial está escrito ni probado todavía: no hay
 * contrato ni credenciales de pruebas, y no se inventa un formato ajeno de
 * memoria. Lo que sí está probado es el comportamiento de este adaptador ante
 * cada respuesta posible (aceptado, observado, rechazado, caído, mal
 * configurado, respuesta ilegible) contra un servidor de pruebas.
 *
 * ─── DECISIONES ─────────────────────────────────────────────────────────
 *  · Idempotencia: cada envío lleva `Idempotency-Key` = RUC-tipo-serie-correlativo.
 *    Reintentar tras un corte no emite dos veces.
 *  · Qué se reintenta: red caída, timeout, 408, 429 y 5xx → PENDIENTE
 *    reintentable. Un 4xx (salvo 401/403/408/429) es el PSE diciendo que el
 *    comprobante está mal: RECHAZADO, y reintentar no lo arregla.
 *  · 401/403 NO es un rechazo del comprobante sino un problema de
 *    configuración: se lanza `ErrorConfiguracionProveedor` y el comprobante no
 *    cambia de estado.
 *  · Una respuesta 2xx ilegible se trata como fallo transitorio, nunca como
 *    aceptación.
 */

export class ErrorConfiguracionProveedor extends Error {
  constructor(mensaje: string) { super(mensaje); this.name = 'ErrorConfiguracionProveedor' }
}

const ESTADOS = ['ACEPTADO', 'OBSERVADO', 'RECHAZADO', 'ENVIADO', 'PENDIENTE'] as const

const respuestaSchema = z.object({
  estado: z.enum(ESTADOS),
  /** DigestValue de la firma: es el «hash» del comprobante. */
  hash: z.string().max(200).nullish(),
  codigo: z.string().max(40).nullish(),
  mensaje: z.string().max(2000).nullish(),
  ticket: z.string().max(200).nullish(),
  id: z.string().max(200).nullish(),
})

/** La baja puede terminar en ANULADO (comunicación de baja aceptada). */
const bajaSchema = respuestaSchema.extend({ estado: z.enum([...ESTADOS, 'ANULADO']) })

const saludSchema = z.object({
  ok: z.boolean(),
  mensaje: z.string().max(500).nullish(),
  certificado_vence_en: z.string().max(40).nullish(),
})

const descargaSchema = z.object({
  contenido_base64: z.string(),
  nombre: z.string().max(200),
  mime: z.string().max(100),
})

/** Texto de un tercero que acabará en pantalla: sin caracteres de control y acotado. */
// eslint-disable-next-line no-control-regex
const limpio = (s: string | null | undefined) => (s ? s.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, 300) : null)

export interface OpcionesPse { permitirRedLocal?: boolean; timeoutMs?: number }

export function crearProveedorPseRest(opciones: OpcionesPse = {}): ProveedorFacturacion {
  const timeoutMs = opciones.timeoutMs ?? 15_000

  async function base(c: CredencialesProveedor): Promise<string> {
    if (!c.urlBase || !c.token) {
      throw new ErrorConfiguracionProveedor('Faltan la URL o el token del proveedor de facturación.')
    }
    // SSRF: la URL la escribió un usuario. (Las pruebas locales la saltan.)
    if (!opciones.permitirRedLocal) {
      try { await validarUrlPse(c.urlBase) } catch (e) {
        throw new ErrorConfiguracionProveedor(`La URL del proveedor no es válida: ${(e as Error).message}`)
      }
    }
    return c.urlBase.replace(/\/+$/, '')
  }

  const cab = (c: CredencialesProveedor, extra: Record<string, string> = {}) => ({
    Authorization: `Bearer ${c.token}`, Accept: 'application/json', 'Content-Type': 'application/json', ...extra,
  })

  type Resultado = { tipo: 'ok'; json: unknown } | { tipo: 'rechazo'; mensaje: string | null; codigo: string } | { tipo: 'transitorio'; mensaje: string }

  async function llamar(url: string, o: OpcionesHttp): Promise<Resultado> {
    let r
    try {
      r = await peticionHttp(url, { timeoutMs, permitirRedLocal: opciones.permitirRedLocal, ...o })
    } catch (e) {
      return { tipo: 'transitorio', mensaje: e instanceof Error && e.name === 'TiempoAgotado' ? 'El proveedor tardó demasiado en responder.' : 'No se pudo contactar al proveedor.' }
    }
    if (r.status === 401 || r.status === 403) {
      throw new ErrorConfiguracionProveedor('El proveedor rechazó el token. Revisa las credenciales de facturación.')
    }
    if (r.status === 408 || r.status === 429 || r.status >= 500) {
      return { tipo: 'transitorio', mensaje: `El proveedor respondió ${r.status}.` }
    }
    let json: unknown = null
    try { json = r.cuerpo ? JSON.parse(r.cuerpo) : null } catch { json = null }
    if (r.status >= 400) {
      const m = json && typeof json === 'object' ? (json as { mensaje?: unknown }).mensaje : null
      return { tipo: 'rechazo', mensaje: limpio(typeof m === 'string' ? m : null), codigo: String(r.status) }
    }
    if (r.status >= 300) return { tipo: 'transitorio', mensaje: 'El proveedor intentó redirigir la petición.' }
    return { tipo: 'ok', json }
  }

  function aEmision(r: z.infer<typeof respuestaSchema>): ResultadoEmision {
    const estado: TaxDocumentStatus = r.estado === 'PENDIENTE' ? 'ENVIADO' : r.estado
    const aceptado = estado === 'ACEPTADO' || estado === 'OBSERVADO'
    return {
      estado, idExterno: r.id ?? null, ticket: r.ticket ?? null,
      codigoRespuesta: r.codigo ?? null, mensaje: limpio(r.mensaje),
      // El hash solo cuenta si el comprobante quedó aceptado.
      hashXml: aceptado ? (r.hash ?? null) : null,
      reintentable: false,
    }
  }

  const ilegible = (): ResultadoEmision => ({
    estado: 'PENDIENTE', idExterno: null, ticket: null, codigoRespuesta: null,
    mensaje: 'La respuesta del proveedor no se pudo interpretar.', hashXml: null, reintentable: true,
  })

  return {
    nombre: 'pse-rest',

    async emitir(comprobante: ComprobanteFiscal, cred): Promise<ResultadoEmision> {
      const url = await base(cred)
      const xml = construirXmlUbl(comprobante)
      const clave = `${comprobante.emisor.ruc}-${comprobante.tipoComprobante}-${comprobante.serie}-${comprobante.correlativo}`
      const r = await llamar(`${url}/comprobantes`, {
        metodo: 'POST', cabeceras: cab(cred, { 'Idempotency-Key': clave }),
        cuerpo: JSON.stringify({ version: 1, comprobante, xml_ubl_base64: Buffer.from(xml, 'utf8').toString('base64') }),
      })
      if (r.tipo === 'transitorio') {
        return { estado: 'PENDIENTE', idExterno: null, ticket: null, codigoRespuesta: null, mensaje: r.mensaje, hashXml: null, reintentable: true }
      }
      if (r.tipo === 'rechazo') {
        return { estado: 'RECHAZADO', idExterno: null, ticket: null, codigoRespuesta: r.codigo, mensaje: r.mensaje ?? `El proveedor rechazó el comprobante (${r.codigo}).`, hashXml: null, reintentable: false }
      }
      const p = respuestaSchema.safeParse(r.json)
      return p.success ? aEmision(p.data) : ilegible()
    },

    async consultarEstado(ref, cred): Promise<EstadoComprobante> {
      const url = await base(cred)
      const id = encodeURIComponent(ref.idExterno ?? `${ref.serie}-${ref.correlativo}`)
      const r = await llamar(`${url}/comprobantes/${id}`, { cabeceras: cab(cred) })
      if (r.tipo !== 'ok') {
        return { estado: 'ENVIADO', codigoRespuesta: null, mensaje: r.tipo === 'transitorio' ? r.mensaje : r.mensaje, aceptadoEn: null }
      }
      const p = respuestaSchema.safeParse(r.json)
      if (!p.success) return { estado: 'ENVIADO', codigoRespuesta: null, mensaje: 'La respuesta del proveedor no se pudo interpretar.', aceptadoEn: null }
      const e = aEmision(p.data)
      return { estado: e.estado, hashXml: e.hashXml, codigoRespuesta: e.codigoRespuesta, mensaje: e.mensaje, aceptadoEn: null }
    },

    async anular(ref, motivo, cred): Promise<ResultadoBaja> {
      const url = await base(cred)
      const id = encodeURIComponent(ref.idExterno ?? `${ref.serie}-${ref.correlativo}`)
      const r = await llamar(`${url}/comprobantes/${id}/baja`, { metodo: 'POST', cabeceras: cab(cred), cuerpo: JSON.stringify({ motivo }) })
      if (r.tipo === 'transitorio') return { ticket: null, estado: 'ACEPTADO', mensaje: r.mensaje }
      if (r.tipo === 'rechazo') return { ticket: null, estado: 'ACEPTADO', mensaje: r.mensaje ?? 'El proveedor no aceptó la baja.' }
      const p = bajaSchema.safeParse(r.json)
      if (!p.success) return { ticket: null, estado: 'ACEPTADO', mensaje: 'La respuesta del proveedor no se pudo interpretar.' }
      return { ticket: p.data.ticket ?? null, estado: p.data.estado === 'PENDIENTE' ? 'ENVIADO' : p.data.estado, mensaje: limpio(p.data.mensaje) }
    },

    async descargar(ref, formato: FormatoDescarga, cred): Promise<Descarga> {
      const url = await base(cred)
      const id = encodeURIComponent(ref.idExterno ?? `${ref.serie}-${ref.correlativo}`)
      const r = await llamar(`${url}/comprobantes/${id}/descarga/${formato.toLowerCase()}`, { cabeceras: cab(cred), maxBytes: 8_388_608 })
      const p = r.tipo === 'ok' ? descargaSchema.safeParse(r.json) : null
      if (!p?.success) throw new ErrorConfiguracionProveedor('No se pudo descargar el archivo del proveedor.')
      return { formato, contenidoBase64: p.data.contenido_base64, nombreArchivo: p.data.nombre, tipoMime: p.data.mime }
    },

    async verificarCredenciales(cred) {
      const url = await base(cred)
      const r = await llamar(`${url}/salud`, { cabeceras: cab(cred) })
      if (r.tipo !== 'ok') return { ok: false, mensaje: r.mensaje ?? 'El proveedor no respondió.' }
      const p = saludSchema.safeParse(r.json)
      if (!p.success) return { ok: false, mensaje: 'La respuesta del proveedor no se pudo interpretar.' }
      return { ok: p.data.ok, mensaje: limpio(p.data.mensaje) ?? (p.data.ok ? 'Conexión correcta.' : 'El proveedor informa un problema.'), certificadoVenceEn: p.data.certificado_vence_en ?? undefined }
    },
  }
}
