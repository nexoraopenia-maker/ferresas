/**
 * Re-cifrado de los secretos guardados con la clave maestra vigente (S2). Sirve para ROTAR la clave sin pedirle a nadie que vuelva a subir nada:
 * se agrega la clave nueva (`SECRETOS_CLAVES`), se declara actual (`SECRETOS_CLAVE_ACTUAL`), se corre esto y, cuando no queda nada con la clave
 * vieja, se retira del entorno. Recibe el cliente BASE (recorre todos los negocios).
 *
 *  · Por defecto SOLO MIRA: cuenta qué quedaría por re-cifrar y qué no se puede leer. Con `aplicar` escribe.
 *  · Cada valor se descifra y se vuelve a cifrar con el MISMO `aad` (negocio / usuario), así que sigue atado a su dueño.
 *  · Un valor que NO se puede leer (clave retirada, dato manipulado) se reporta y se deja intacto: nunca se pierde un secreto por re-cifrar.
 *  · Escribe de a un registro y vuelve a leer lo escrito antes de seguir: si el resultado no descifra, no sigue.
 *  · Nunca imprime un secreto, solo identificadores de registro.
 */
import { descifrar, necesitaRecifrado, recifrar } from '@/lib/cifrado'
import { aad as aadMfa } from './mfa-service'

export interface InformeRecifrado {
  revisados: number
  yaVigentes: number
  recifrados: number
  /** Valores que no se pudieron leer: no se tocan. */
  ilegibles: { tabla: string; id: string; campo: string }[]
  aplicado: boolean
}

interface Lector {
  sunatCredential: {
    findMany(a: { select: Record<string, true> }): Promise<{ id: string; tenantId: string; pfxEnc: string; pfxPasswordEnc: string; solPasswordEnc: string }[]>
    update(a: { where: { id: string }; data: Record<string, string> }): Promise<unknown>
  }
  tenant: {
    findMany(a: { where: Record<string, unknown>; select: Record<string, true> }): Promise<{ id: string; pseTokenEnc: string | null }[]>
    update(a: { where: { id: string }; data: Record<string, string> }): Promise<unknown>
  }
  user: {
    findMany(a: { where: Record<string, unknown>; select: Record<string, true> }): Promise<{ id: string; mfaSecretEnc: string | null }[]>
    update(a: { where: { id: string }; data: Record<string, string> }): Promise<unknown>
  }
}

export async function recifrarSecretos(db: Lector, opciones: { aplicar?: boolean } = {}): Promise<InformeRecifrado> {
  const informe: InformeRecifrado = { revisados: 0, yaVigentes: 0, recifrados: 0, ilegibles: [], aplicado: opciones.aplicar === true }

  const tratar = async (tabla: string, id: string, campo: string, valor: string | null, aad: string, escribir: (nuevo: string) => Promise<unknown>) => {
    if (!valor) return
    informe.revisados++
    if (!necesitaRecifrado(valor)) { informe.yaVigentes++; return }
    let nuevo: string
    try { nuevo = recifrar(valor, aad) } catch { informe.ilegibles.push({ tabla, id, campo }); return }
    if (!opciones.aplicar) { informe.recifrados++; return }
    await escribir(nuevo)
    descifrar(nuevo, aad)   // si lo escrito no se lee, se detiene aquí (lanza)
    informe.recifrados++
  }

  for (const c of await db.sunatCredential.findMany({ select: { id: true, tenantId: true, pfxEnc: true, pfxPasswordEnc: true, solPasswordEnc: true } })) {
    for (const campo of ['pfxEnc', 'pfxPasswordEnc', 'solPasswordEnc'] as const) {
      await tratar('sunat_credentials', c.id, campo, c[campo], c.tenantId, (n) => db.sunatCredential.update({ where: { id: c.id }, data: { [campo]: n } }))
    }
  }
  for (const t of await db.tenant.findMany({ where: { pseTokenEnc: { not: null } }, select: { id: true, pseTokenEnc: true } })) {
    await tratar('tenants', t.id, 'pseTokenEnc', t.pseTokenEnc, t.id, (n) => db.tenant.update({ where: { id: t.id }, data: { pseTokenEnc: n } }))
  }
  for (const u of await db.user.findMany({ where: { mfaSecretEnc: { not: null } }, select: { id: true, mfaSecretEnc: true } })) {
    await tratar('users', u.id, 'mfaSecretEnc', u.mfaSecretEnc, aadMfa(u.id), (n) => db.user.update({ where: { id: u.id }, data: { mfaSecretEnc: n } }))
  }
  return informe
}
