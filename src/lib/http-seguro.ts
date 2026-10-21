import { lookup as dnsLookup } from 'node:dns'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { esIpInterna, validarFormaUrl, UrlNoPermitida } from '@/features/invoicing/url-segura'

/**
 * Cliente HTTP para hablar con terceros desde el servidor (PSE, padrón).
 *
 *  · Tiempo máximo TOTAL (no solo de conexión): una respuesta que gotea no
 *    deja la venta esperando.
 *  · Tamaño máximo de respuesta (1 MB por defecto).
 *  · NO sigue redirecciones: un proveedor (o alguien que se haga pasar por él)
 *    no puede mandarnos a otra dirección.
 *  · `lookup` propio: la IP se vuelve a comprobar en el momento de CONECTAR, así
 *    un nombre que cambie de IP entre la validación y la conexión (DNS
 *    rebinding) tampoco llega a una red interna.
 *
 * `permitirRedLocal` existe SOLO para las pruebas, que levantan un servidor en
 * 127.0.0.1. Ningún código de producción lo activa.
 */

export class RespuestaDemasiadoGrande extends Error {
  constructor() { super('La respuesta del servicio es demasiado grande.'); this.name = 'RespuestaDemasiadoGrande' }
}
export class TiempoAgotado extends Error {
  constructor(ms: number) { super(`El servicio no respondió en ${ms} ms.`); this.name = 'TiempoAgotado' }
}

export interface OpcionesHttp {
  metodo?: 'GET' | 'POST'
  cabeceras?: Record<string, string>
  cuerpo?: string
  timeoutMs?: number
  maxBytes?: number
  permitirRedLocal?: boolean
}

export interface RespuestaHttp { status: number; cuerpo: string; cabeceras: Record<string, string | string[] | undefined> }

export async function peticionHttp(url: string, o: OpcionesHttp = {}): Promise<RespuestaHttp> {
  const permitirRedLocal = o.permitirRedLocal === true
  const timeoutMs = o.timeoutMs ?? 15_000
  const maxBytes = o.maxBytes ?? 1_048_576

  let u: URL
  if (permitirRedLocal) {
    u = new URL(url)
  } else {
    u = validarFormaUrl(url)
  }
  const esHttps = u.protocol === 'https:'
  const pedir = esHttps ? httpsRequest : httpRequest

  return new Promise<RespuestaHttp>((resolve, reject) => {
    let terminado = false
    const fin = (fn: () => void) => { if (!terminado) { terminado = true; clearTimeout(reloj); fn() } }

    const req = pedir(
      u,
      {
        method: o.metodo ?? 'GET',
        headers: { ...o.cabeceras, ...(o.cuerpo !== undefined ? { 'Content-Length': String(Buffer.byteLength(o.cuerpo)) } : {}) },
        // Comprobación de la IP real al conectar (anti-rebinding).
        lookup: (host, opciones, cb) => {
          dnsLookup(host, opciones as never, ((err: Error | null, address: unknown, family?: number) => {
            if (!err && !permitirRedLocal) {
              const lista = Array.isArray(address) ? (address as { address: string }[]).map((a) => a.address) : [String(address)]
              if (lista.some(esIpInterna)) return (cb as (e: Error) => void)(new UrlNoPermitida('Esa dirección apunta a una red privada.'))
            }
            ;(cb as (...a: unknown[]) => void)(err, address, family)
          }) as never)
        },
      },
      (res) => {
        const trozos: Buffer[] = []
        let total = 0
        res.on('data', (t: Buffer) => {
          total += t.length
          if (total > maxBytes) { res.destroy(); req.destroy(); fin(() => reject(new RespuestaDemasiadoGrande())); return }
          trozos.push(t)
        })
        res.on('end', () => fin(() => resolve({
          status: res.statusCode ?? 0, cuerpo: Buffer.concat(trozos).toString('utf8'), cabeceras: res.headers,
        })))
        res.on('error', (e) => fin(() => reject(e)))
      },
    )

    const reloj = setTimeout(() => { req.destroy(); fin(() => reject(new TiempoAgotado(timeoutMs))) }, timeoutMs)
    req.on('error', (e) => fin(() => reject(e)))
    if (o.cuerpo !== undefined) req.write(o.cuerpo)
    req.end()
  })
}
