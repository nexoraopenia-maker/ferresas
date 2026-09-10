import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { prisma } from './prisma'

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
}

/**
 * Hash descartable con el que comparar cuando el correo NO existe.
 *
 * Sin esto, un correo inexistente responde en microsegundos y uno real tarda
 * ~100 ms haciendo bcrypt. Esa diferencia es medible desde fuera y permite
 * enumerar qué correos están registrados en el SaaS. Comparando siempre
 * contra algo, el tiempo de respuesta no distingue un caso del otro.
 */
const DUMMY_HASH = bcrypt.hashSync('contraseña-que-nunca-se-usa', 12)

export async function verifyCredentials(
  raw: unknown,
): Promise<VerifiedUser | null> {
  const parsed = credentialsSchema.safeParse(raw)
  if (!parsed.success) return null

  const { email, password } = parsed.data

  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      name: true,
      passwordHash: true,
      isActive: true,
      deletedAt: true,
    },
  })

  // Se compara SIEMPRE, exista el usuario o no (ver DUMMY_HASH).
  const hash = user?.passwordHash ?? DUMMY_HASH
  const coincide = await bcrypt.compare(password, hash)

  if (!user || !user.passwordHash || !coincide) return null

  // Un usuario desactivado o borrado tampoco entra. Se comprueba DESPUÉS del
  // bcrypt para no reintroducir la diferencia de tiempos.
  if (!user.isActive || user.deletedAt) return null

  return { id: user.id, email: user.email, name: user.name }
}
