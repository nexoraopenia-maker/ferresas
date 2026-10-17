import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { prisma } from './prisma'
import type { Role } from '@/generated/prisma/enums'

/**
 * Verificación de credenciales. Vive fuera de la config de NextAuth para
 * poder probarla contra una BD real sin montar el flujo de auth entero.
 */

export const credentialsSchema = z.object({
  email: z.email('Correo inválido.').max(200).toLowerCase().trim(),
  password: z.string().min(1, 'Escribe tu contraseña.').max(200),
})

export interface VerifiedUser {
  id: string
  email: string
  name: string
  /** Rol en el momento del login. Viaja al JWT solo para enrutar. */
  role: Role
}

/**
 * Resultado CLASIFICADO de la verificación.
 *
 * ─── POR QUÉ NO BASTA DEVOLVER null ──────────────────────────────────────
 *
 * Antes esta función devolvía `VerifiedUser | null` y no capturaba errores.
 * Consecuencia: si Neon estaba inalcanzable, Prisma lanzaba, NextAuth lo
 * atrapaba y respondía `CredentialsSignin` — el MISMO error que una
 * contraseña equivocada.
 *
 * Es el peor modo de fallo posible para depurar: un problema de
 * infraestructura se disfraza de error del usuario, así que uno pasa horas
 * revisando hashes y contraseñas mientras el fallo real está en la cadena de
 * conexión. Clasificar el motivo cuesta veinte líneas y ahorra esa tarde.
 *
 * Lo que se le dice al CLIENTE sigue siendo genérico: la clasificación es
 * para el log del servidor.
 */
export type CredentialsOutcome =
  | { ok: true; user: VerifiedUser }
  /** Correo mal formado o campos vacíos. */
  | { ok: false; reason: 'INVALID_INPUT' }
  /** No existe ningún usuario con ese correo. */
  | { ok: false; reason: 'NO_SUCH_USER' }
  /** Existe pero entró por OAuth y no tiene contraseña. */
  | { ok: false; reason: 'NO_PASSWORD_SET' }
  /** El bcrypt no coincide. */
  | { ok: false; reason: 'BAD_PASSWORD' }
  /** Desactivado o borrado lógicamente. */
  | { ok: false; reason: 'USER_DISABLED' }
  /** La base no respondió. NO es culpa del usuario. */
  | { ok: false; reason: 'DATABASE_ERROR'; detail: string }

/**
 * Hash descartable con el que comparar cuando el correo NO existe.
 *
 * Sin esto, un correo inexistente responde en microsegundos y uno real tarda
 * ~100 ms haciendo bcrypt. Esa diferencia es medible desde fuera y permite
 * enumerar qué correos están registrados en el SaaS. Comparando siempre
 * contra algo, el tiempo de respuesta no distingue un caso del otro.
 */
const DUMMY_HASH = bcrypt.hashSync('contraseña-que-nunca-se-usa', 12)

export async function verifyCredentialsDetailed(
  raw: unknown,
): Promise<CredentialsOutcome> {
  const parsed = credentialsSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, reason: 'INVALID_INPUT' }

  const { email, password } = parsed.data

  let user: {
    id: string
    email: string
    name: string
    role: Role
    passwordHash: string | null
    isActive: boolean
    deletedAt: Date | null
  } | null

  try {
    user = await prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        passwordHash: true,
        isActive: true,
        deletedAt: true,
      },
    })
  } catch (e) {
    // La causa más probable en producción: cadena de conexión mal puesta,
    // base suspendida o conexiones agotadas. Se distingue explícitamente.
    return {
      ok: false,
      reason: 'DATABASE_ERROR',
      detail: e instanceof Error ? `${e.name}: ${e.message.split('\n')[0]}` : String(e),
    }
  }

  // Se compara SIEMPRE, exista el usuario o no (ver DUMMY_HASH).
  const hash = user?.passwordHash ?? DUMMY_HASH
  let coincide: boolean
  try {
    coincide = await bcrypt.compare(password, hash)
  } catch (e) {
    // Un hash corrupto en la base entra aquí: bcrypt lanza en vez de
    // devolver false, y sin esta rama se leería como contraseña incorrecta.
    return {
      ok: false,
      reason: 'DATABASE_ERROR',
      detail: `bcrypt: ${e instanceof Error ? e.message : String(e)}`,
    }
  }

  if (!user) return { ok: false, reason: 'NO_SUCH_USER' }
  if (!user.passwordHash) return { ok: false, reason: 'NO_PASSWORD_SET' }
  if (!coincide) return { ok: false, reason: 'BAD_PASSWORD' }

  // Un usuario desactivado o borrado tampoco entra. Se comprueba DESPUÉS del
  // bcrypt para no reintroducir la diferencia de tiempos.
  if (!user.isActive || user.deletedAt) return { ok: false, reason: 'USER_DISABLED' }

  /*
   * El ROL viaja al JWT para que el proxy pueda enrutar sin consultar la
   * base. Es identidad-en-el-momento-del-login, no autorización: cada página
   * y cada Server Action lo revalidan contra la base. Ver la nota de
   * src/proxy.ts sobre qué garantiza y qué no.
   */
  return {
    ok: true,
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
  }
}

/**
 * Forma compatible con el resto del código y con los tests: devuelve el
 * usuario o null. Usa `verifyCredentialsDetailed` cuando necesites el motivo.
 */
export async function verifyCredentials(raw: unknown): Promise<VerifiedUser | null> {
  const r = await verifyCredentialsDetailed(raw)
  return r.ok ? r.user : null
}
