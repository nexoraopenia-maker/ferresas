import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * Cifrado de secretos por tenant (AES-256-GCM).
 *
 * Para lo que el negocio nos confía y no podemos guardar en claro: hoy el
 * token del PSE. La clave maestra vive SOLO en el entorno (`PSE_MASTER_KEY`),
 * nunca en la base ni en el código; quien lea la base sin la clave ve bytes.
 *
 *  · GCM autentica: un valor manipulado no «descifra mal», FALLA.
 *  · El `tenantId` entra como dato asociado (AAD): copiar el texto cifrado de
 *    un negocio a otro tampoco funciona, aunque se tenga la clave.
 *  · IV aleatorio de 12 bytes por cifrado: el mismo token da textos distintos.
 *  · CLAVE VERSIONADA (F S2): cada valor lleva el identificador de la clave con que
 *    se cifró, así que se puede ROTAR sin perder nada: se agrega la clave nueva, se
 *    declara como actual, se re-cifra todo (`scripts/recifrar-secretos.ts`) y recién
 *    entonces se retira la vieja.
 *
 * Formato nuevo: `v2.<kid>.<iv>.<etiqueta>.<cifrado>` (todo base64url; `kid` es el
 * identificador de la clave). Formato anterior, que SIGUE leyéndose: `v1.<iv>.<etiqueta>.<cifrado>`
 * (sin identificador: se prueba con las claves configuradas).
 *
 * Entorno:
 *   · `SECRETOS_CLAVES`        JSON `{"1":"<clave>","2":"<clave>"}` con TODAS las claves vigentes (32 bytes, base64 o hex).
 *   · `SECRETOS_CLAVE_ACTUAL`  identificador de la que cifra lo nuevo (por defecto "1").
 *   · `PSE_MASTER_KEY`         compatibilidad: si `SECRETOS_CLAVES` no declara "1", esta es la clave "1".
 *   · `PSE_MASTER_KEY_PREVIOUS` compatibilidad: una clave más vieja que sirve para LEER valores `v1` y los `v2` de la clave «1».
 */

const VERSION_V1 = 'v1'
const VERSION_V2 = 'v2'
// «v1» y «v2» no pueden ser identificadores: se confundirían con la versión del formato.
const KID_VALIDO = /^(?!v1$|v2$)[A-Za-z0-9_-]{1,16}$/

export class ClaveMaestraAusente extends Error {
  constructor() {
    super('Falta la clave maestra de cifrado (SECRETOS_CLAVES, o PSE_MASTER_KEY de 32 bytes en base64 o 64 en hex): sin ella no se guardan ni se leen credenciales cifradas.')
    this.name = 'ClaveMaestraAusente'
  }
}

export class CifradoInvalido extends Error {
  constructor(motivo = 'El dato cifrado no es válido, fue manipulado o la clave no corresponde.') {
    super(motivo)
    this.name = 'CifradoInvalido'
  }
}

/** Acepta 32 bytes en base64 (44 chars) o en hex (64 chars). */
export function leerClave(valor: string | undefined): Buffer | null {
  if (!valor) return null
  const v = valor.trim()
  const buf = /^[0-9a-fA-F]{64}$/.test(v) ? Buffer.from(v, 'hex') : Buffer.from(v, 'base64')
  return buf.length === 32 ? buf : null
}

interface Llavero {
  claves: Map<string, Buffer>
  actual: string | null
  /** Claves viejas que solo sirven para leer valores `v1`. */
  heredadas: Buffer[]
}

/** Lee las claves del entorno cada vez (los entornos de prueba las cambian en caliente). Una clave mal formada se ignora: nunca se cifra con basura. */
function llavero(): Llavero {
  const claves = new Map<string, Buffer>()
  const crudo = process.env.SECRETOS_CLAVES
  if (crudo) {
    try {
      const obj = JSON.parse(crudo) as Record<string, unknown>
      for (const [kid, v] of Object.entries(obj ?? {})) {
        const k = typeof v === 'string' ? leerClave(v) : null
        if (KID_VALIDO.test(kid) && k) claves.set(kid, k)
      }
    } catch { /* JSON ilegible: se queda sin esas claves */ }
  }
  const legado = leerClave(process.env.PSE_MASTER_KEY)
  if (legado && !claves.has('1')) claves.set('1', legado)
  const anterior = leerClave(process.env.PSE_MASTER_KEY_PREVIOUS)
  const declarada = (process.env.SECRETOS_CLAVE_ACTUAL ?? '1').trim()
  return { claves, actual: claves.has(declarada) ? declarada : null, heredadas: anterior ? [anterior] : [] }
}

function claveActual(): { kid: string; clave: Buffer } {
  const l = llavero()
  if (!l.actual) throw new ClaveMaestraAusente()
  return { kid: l.actual, clave: l.claves.get(l.actual)! }
}

function cifrarCon(texto: string, aad: string, clave: Buffer): { iv: Buffer; tag: Buffer; ct: Buffer } {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', clave, iv)
  c.setAAD(Buffer.from(aad))
  const ct = Buffer.concat([c.update(texto, 'utf8'), c.final()])
  return { iv, tag: c.getAuthTag(), ct }
}

/**
 * Cifra con la clave ACTUAL y deja el identificador en el valor (`v2`). Pasando `clave` explícita (pruebas, o claves que no vienen
 * del entorno) se escribe el formato `v1` de siempre, sin identificador.
 */
export function cifrar(texto: string, aad: string, clave?: Buffer): string {
  if (clave) {
    const { iv, tag, ct } = cifrarCon(texto, aad, clave)
    return [VERSION_V1, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.')
  }
  const { kid, clave: k } = claveActual()
  const { iv, tag, ct } = cifrarCon(texto, aad, k)
  return [VERSION_V2, kid, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.')
}

function descifrarCon(iv: string, tag: string, ct: string, aad: string, clave: Buffer): string {
  const d = createDecipheriv('aes-256-gcm', clave, Buffer.from(iv, 'base64url'))
  d.setAAD(Buffer.from(aad))
  d.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8')
}

export function descifrar(valor: string, aad: string, clave?: Buffer): string {
  const partes = valor.split('.')
  if (clave) {
    const [v, iv, tag, ct] = partes
    if (v !== VERSION_V1 || !iv || !tag || !ct) throw new CifradoInvalido('Formato de dato cifrado desconocido.')
    try { return descifrarCon(iv, tag, ct, aad, clave) } catch { throw new CifradoInvalido() }
  }
  const l = llavero()
  if (partes[0] === VERSION_V2) {
    const [, kid, iv, tag, ct] = partes
    if (!kid || !iv || !tag || !ct) throw new CifradoInvalido('Formato de dato cifrado desconocido.')
    if (l.claves.size === 0) throw new ClaveMaestraAusente()
    const k = l.claves.get(kid)
    // Compatibilidad: la clave «1» es `PSE_MASTER_KEY`, y el procedimiento de siempre para rotarla (la nueva en `PSE_MASTER_KEY`, la vieja en `_PREVIOUS`) debe seguir leyendo.
    const candidatas = [...(k ? [k] : []), ...(kid === '1' ? l.heredadas : [])]
    if (candidatas.length === 0) throw new CifradoInvalido(`El dato se cifró con la clave «${kid}», que ya no está configurada en el servidor.`)
    for (const c of candidatas) {
      try { return descifrarCon(iv, tag, ct, aad, c) } catch { /* prueba con la siguiente */ }
    }
    throw new CifradoInvalido()
  }
  const [v, iv, tag, ct] = partes
  if (v !== VERSION_V1 || !iv || !tag || !ct) throw new CifradoInvalido('Formato de dato cifrado desconocido.')
  if (l.claves.size === 0) throw new ClaveMaestraAusente()
  // `v1` no dice con qué clave se cifró: se prueban las configuradas (la actual primero) y la heredada.
  const candidatas = [...(l.actual ? [l.claves.get(l.actual)!] : []), ...[...l.claves.entries()].filter(([kid]) => kid !== l.actual).map(([, k]) => k), ...l.heredadas]
  for (const k of candidatas) {
    try { return descifrarCon(iv, tag, ct, aad, k) } catch { /* prueba con la siguiente */ }
  }
  throw new CifradoInvalido()
}

/** ¿Está configurada la clave maestra actual? Para avisar en pantalla antes de intentar guardar. */
export const hayClaveMaestra = () => llavero().actual !== null

/** Con qué versión se cifró un valor: el identificador de la clave (`v2`), `'v1'` si es del formato anterior, `null` si no se reconoce. */
export function versionDeClave(valor: string): string | null {
  const p = valor.split('.')
  if (p[0] === VERSION_V2 && p.length === 5) return p[1] ?? null
  return p[0] === VERSION_V1 && p.length === 4 ? 'v1' : null
}

/** ¿Hay que volver a cifrar este valor para que quede con la clave actual? (Es `v1`, o `v2` con otra clave.) */
export function necesitaRecifrado(valor: string): boolean {
  const v = versionDeClave(valor)
  return v !== null && v !== (llavero().actual ?? '')
}

/** Descifra con cualquier clave aún configurada y cifra con la actual. Mismo `aad` (el negocio). */
export const recifrar = (valor: string, aad: string): string => cifrar(descifrar(valor, aad), aad)
