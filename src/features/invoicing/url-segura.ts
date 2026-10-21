import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/**
 * Validación de la URL del PSE, que la escribe el DUEÑO DEL NEGOCIO y el
 * SERVIDOR consulta: es el caso clásico de SSRF. Sin esto, cualquiera con
 * acceso a la configuración haría que nuestro servidor pidiera
 * `http://169.254.169.254/` (metadatos de la nube) o un servicio interno, y
 * leyera la respuesta en el «mensaje del proveedor».
 *
 * Reglas: solo https; sin usuario ni contraseña en la URL; sin IP literal ni
 * `localhost`; y el nombre, ya resuelto, no puede apuntar a una red privada.
 * Opcionalmente `PSE_ALLOWED_HOSTS` (sufijos separados por coma) limita a los
 * proveedores que decidas contratar.
 */

export class UrlNoPermitida extends Error {
  constructor(motivo: string) { super(motivo); this.name = 'UrlNoPermitida' }
}

/** IPv4/IPv6 que nunca debe alcanzar el servidor por orden de un usuario. */
export function esIpInterna(ip: string): boolean {
  const v = ip.toLowerCase()
  if (isIP(v) === 6) {
    if (v === '::1' || v === '::') return true
    if (v.startsWith('fe80') || v.startsWith('fc') || v.startsWith('fd')) return true          // link-local, ULA
    const mapeada = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v)                                      // IPv4 dentro de IPv6
    return mapeada ? esIpInterna(mapeada[1]!) : false
  }
  const p = v.split('.').map(Number)
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true   // ante la duda, bloquear
  const [a, b] = p as [number, number, number, number]
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||     // CGNAT
    (a === 169 && b === 254) ||               // link-local y metadatos de nube
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    a >= 224                                   // multicast y reservadas
  )
}

/** Comprobaciones SIN red: forma de la URL. */
export function validarFormaUrl(valor: string): URL {
  let u: URL
  try { u = new URL(valor.trim()) } catch { throw new UrlNoPermitida('La URL no es válida.') }
  if (u.protocol !== 'https:') throw new UrlNoPermitida('La URL debe empezar por https://')
  if (u.username || u.password) throw new UrlNoPermitida('La URL no puede llevar usuario ni contraseña.')
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new UrlNoPermitida('Esa dirección no es pública.')
  }
  if (isIP(host)) throw new UrlNoPermitida('Usa el nombre del proveedor, no una dirección IP.')
  if (!host.includes('.')) throw new UrlNoPermitida('Esa dirección no es pública.')

  const permitidos = (process.env.PSE_ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  if (permitidos.length > 0 && !permitidos.some((s) => host === s || host.endsWith(`.${s.replace(/^\./, '')}`))) {
    throw new UrlNoPermitida('Ese proveedor no está en la lista de proveedores permitidos.')
  }
  return u
}

/** Forma + resolución DNS: ningún registro puede ser una IP interna. */
export async function validarUrlPse(valor: string): Promise<URL> {
  const u = validarFormaUrl(valor)
  let dir: { address: string }[]
  try { dir = await lookup(u.hostname.replace(/^\[|\]$/g, ''), { all: true }) } catch {
    throw new UrlNoPermitida('No se pudo resolver el nombre del proveedor.')
  }
  if (dir.length === 0 || dir.some((d) => esIpInterna(d.address))) {
    throw new UrlNoPermitida('Esa dirección apunta a una red privada.')
  }
  return u
}
