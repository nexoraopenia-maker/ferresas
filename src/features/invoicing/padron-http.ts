import { peticionHttp } from '@/lib/http-seguro'
import type { DatosContribuyente, ProveedorPadron, ResultadoPadron } from './padron'

/**
 * Consulta de padrón RUC/DNI por HTTP, con tiempo corto.
 *
 * El mostrador no puede esperar a un servicio de terceros: la consulta tiene
 * 2,5 s como máximo y CUALQUIER fallo (sin configurar, caído, lento, respuesta
 * rara, token vencido, límite de uso) vuelve a `NO_DISPONIBLE`, que la pantalla
 * trata como «teclea el nombre». Nunca lanza y nunca frena una venta.
 *
 * Configuración (solo entorno, nunca en código ni en la base):
 *   PADRON_API_URL    URL base, o plantilla con {tipo} y {numero}
 *                     p. ej. https://api.proveedor.pe/v2/{tipo}?numero={numero}
 *                     Sin plantilla se añade `?tipo=ruc&numero=…`.
 *   PADRON_API_TOKEN  se envía como `Authorization: Bearer …`.
 *
 * ⚠️ NO HAY NINGÚN PROVEEDOR CONTRATADO ni probado. La respuesta se interpreta
 * de forma tolerante (varios nombres habituales de campo, ver `ALIAS`); si el
 * proveedor que se elija usa otros, se añaden aquí y se prueban con su
 * documentación. Si no se reconoce nada, es NO_DISPONIBLE, no un dato inventado.
 *
 * Dos defensas para no castigar al cajero ni pagar de más:
 *  · Cortacircuitos: tras un fallo no se vuelve a llamar durante 30 s.
 *  · Caché de aciertos 6 h: el mismo cliente no se consulta dos veces.
 */

const ALIAS = {
  nombre: ['razonSocial', 'razon_social', 'nombre_o_razon_social', 'nombreRazonSocial', 'nombreCompleto', 'nombre_completo', 'nombre'],
  nombres: ['nombres', 'prenombres'],
  apellidoPaterno: ['apellidoPaterno', 'apellido_paterno'],
  apellidoMaterno: ['apellidoMaterno', 'apellido_materno'],
  direccion: ['direccion', 'direccion_completa', 'domicilio_fiscal', 'domicilioFiscal'],
  estado: ['estado', 'estado_contribuyente', 'estadoContribuyente'],
  condicion: ['condicion', 'condicion_domicilio', 'condicionDomicilio'],
} as const

type Obj = Record<string, unknown>

function primero(o: Obj, claves: readonly string[]): string | null {
  for (const k of claves) {
    const v = o[k]
    if (typeof v === 'string' && v.trim()) return v
  }
  return null
}

// eslint-disable-next-line no-control-regex
const limpio = (s: string, max = 200) => s.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)

/** Interpreta la respuesta; `null` si no trae un nombre reconocible. */
export function interpretarPadron(tipo: 'DNI' | 'RUC', numero: string, json: unknown): DatosContribuyente | null {
  if (!json || typeof json !== 'object') return null
  const raiz = json as Obj
  const o = (raiz.data && typeof raiz.data === 'object' ? raiz.data : raiz) as Obj

  let nombre = primero(o, ALIAS.nombre)
  if (!nombre) {
    const partes = [primero(o, ALIAS.nombres), primero(o, ALIAS.apellidoPaterno), primero(o, ALIAS.apellidoMaterno)].filter(Boolean)
    nombre = partes.length >= 2 ? partes.join(' ') : null
  }
  if (!nombre || limpio(nombre).length < 2) return null

  const dir = primero(o, ALIAS.direccion)
  const estado = primero(o, ALIAS.estado)
  const condicion = primero(o, ALIAS.condicion)
  return {
    tipo, numero, nombre: limpio(nombre).toUpperCase(),
    direccion: dir ? limpio(dir, 300).toUpperCase() : null,
    estado: tipo === 'RUC' && estado ? limpio(estado, 40) : null,
    condicion: tipo === 'RUC' && condicion ? limpio(condicion, 40) : null,
  }
}

export interface OpcionesPadronHttp {
  url: string
  token: string
  timeoutMs?: number
  /** Solo pruebas. */
  permitirRedLocal?: boolean
  /** Reloj inyectable para probar el cortacircuitos y la caché. */
  ahora?: () => number
}

export const TIMEOUT_PADRON_MS = 2500
const PAUSA_TRAS_FALLO_MS = 30_000
const VIDA_CACHE_MS = 6 * 3600_000
const MAX_CACHE = 500

export function construirUrlPadron(plantilla: string, tipo: 'DNI' | 'RUC', numero: string): string {
  const t = tipo.toLowerCase()
  if (plantilla.includes('{numero}')) {
    return plantilla.replace(/\{tipo\}/g, t).replace(/\{numero\}/g, encodeURIComponent(numero))
  }
  return `${plantilla}${plantilla.includes('?') ? '&' : '?'}tipo=${t}&numero=${encodeURIComponent(numero)}`
}

export function crearPadronHttp(o: OpcionesPadronHttp): ProveedorPadron {
  const reloj = o.ahora ?? Date.now
  const timeoutMs = o.timeoutMs ?? TIMEOUT_PADRON_MS
  let pausadoHasta = 0
  const cache = new Map<string, { hasta: number; datos: DatosContribuyente }>()

  const noDisponible = (mensaje: string): ResultadoPadron => ({ ok: false, motivo: 'NO_DISPONIBLE', mensaje })

  return {
    nombre: 'http',
    async consultar(tipo, numero): Promise<ResultadoPadron> {
      const ahora = reloj()
      const k = `${tipo}:${numero}`
      const guardado = cache.get(k)
      if (guardado && guardado.hasta > ahora) return { ok: true, datos: guardado.datos, fuente: 'http (caché)' }
      if (ahora < pausadoHasta) return noDisponible('El servicio de consulta está temporalmente fuera de servicio.')

      const fallar = (mensaje: string) => { pausadoHasta = ahora + PAUSA_TRAS_FALLO_MS; return noDisponible(mensaje) }

      let r
      try {
        r = await peticionHttp(construirUrlPadron(o.url, tipo, numero), {
          cabeceras: { Authorization: `Bearer ${o.token}`, Accept: 'application/json' },
          timeoutMs, maxBytes: 65_536, permitirRedLocal: o.permitirRedLocal,
        })
      } catch {
        return fallar('La consulta de padrón no respondió a tiempo.')
      }

      // El documento no figura (o el proveedor lo considera inválido): no es una caída.
      if (r.status === 404 || r.status === 400 || r.status === 422) {
        return { ok: false, motivo: 'NO_ENCONTRADO', mensaje: 'El documento no figura en el padrón.' }
      }
      if (r.status !== 200) return fallar(`El servicio de padrón respondió ${r.status}.`)

      let json: unknown
      try { json = JSON.parse(r.cuerpo) } catch { return fallar('La respuesta del padrón no se pudo interpretar.') }
      const datos = interpretarPadron(tipo, numero, json)
      if (!datos) return fallar('La respuesta del padrón no se pudo interpretar.')

      if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value as string)
      cache.set(k, { hasta: ahora + VIDA_CACHE_MS, datos })
      return { ok: true, datos, fuente: 'http' }
    },
  }
}
