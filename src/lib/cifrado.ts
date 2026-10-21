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
 *  · Rotación: `PSE_MASTER_KEY_PREVIOUS` se prueba al descifrar si la actual
 *    falla, y el valor se vuelve a cifrar con la actual la próxima vez que se
 *    guarde.
 *
 * Formato: `v1.<iv>.<etiqueta>.<cifrado>`, todo base64url.
 */

const VERSION = 'v1'

export class ClaveMaestraAusente extends Error {
  constructor() {
    super('Falta PSE_MASTER_KEY (32 bytes en base64 o 64 en hex): sin ella no se guardan ni se leen credenciales cifradas.')
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

function claveActual(): Buffer {
  const k = leerClave(process.env.PSE_MASTER_KEY)
  if (!k) throw new ClaveMaestraAusente()
  return k
}

export function cifrar(texto: string, aad: string, clave: Buffer = claveActual()): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', clave, iv)
  c.setAAD(Buffer.from(aad))
  const ct = Buffer.concat([c.update(texto, 'utf8'), c.final()])
  return [VERSION, iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.')
}

function descifrarCon(valor: string, aad: string, clave: Buffer): string {
  const [v, iv, tag, ct] = valor.split('.')
  if (v !== VERSION || !iv || !tag || !ct) throw new CifradoInvalido('Formato de dato cifrado desconocido.')
  const d = createDecipheriv('aes-256-gcm', clave, Buffer.from(iv, 'base64url'))
  d.setAAD(Buffer.from(aad))
  d.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8')
}

export function descifrar(valor: string, aad: string, clave: Buffer = claveActual()): string {
  try {
    return descifrarCon(valor, aad, clave)
  } catch (e) {
    if (e instanceof ClaveMaestraAusente) throw e
    const anterior = leerClave(process.env.PSE_MASTER_KEY_PREVIOUS)
    if (anterior) {
      try { return descifrarCon(valor, aad, anterior) } catch { /* cae al error genérico */ }
    }
    throw new CifradoInvalido()
  }
}

/** ¿Está configurada la clave maestra? Para avisar en pantalla antes de intentar guardar. */
export const hayClaveMaestra = () => leerClave(process.env.PSE_MASTER_KEY) !== null
