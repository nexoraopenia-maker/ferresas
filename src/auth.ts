import { headers } from 'next/headers'
import NextAuth from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import { verifyCredentials } from '@/lib/credentials'
import { checkRateLimit, clientIp, RATE_RULES } from '@/lib/rate-limit'
import { ROUTES } from '@/lib/route-access'

/**
 * Configuración de NextAuth (Auth.js v5).
 *
 * ─── LA DECISIÓN IMPORTANTE ──────────────────────────────────────────────
 *
 * El JWT lleva ÚNICAMENTE la identidad: quién es el usuario. NO lleva
 * tenantId, ni role, ni estado de suscripción.
 *
 * La tentación es meterlos ahí para ahorrarse una consulta. El problema es
 * que un JWT es inmutable hasta que caduca: si el ferretero cancela su
 * suscripción, o el dueño degrada a un empleado de ADMIN a VENDEDOR, ese
 * cambio no surte efecto hasta que el token expire. Durante horas, alguien
 * seguiría escribiendo con permisos que ya no tiene — y en un SaaS cuyo
 * negocio ES el cobro, "sigue funcionando aunque no pague" no es un detalle.
 *
 * Así que: IDENTIDAD en el token, AUTORIZACIÓN desde la base de datos en cada
 * petición. Es una consulta indexada por request; el proxy de Next corre en
 * Node.js, así que puede hacerla sin acrobacias.
 *
 * Estrategia JWT (no sesiones en BD) porque el proveedor Credentials la
 * exige. El modelo Session del schema queda reservado para cuando se añada
 * OAuth con el PrismaAdapter.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  session: {
    strategy: 'jwt',
    // Jornada de trabajo: el almacenero no debería reloguearse a media tarde,
    // pero tampoco dejar la sesión viva una semana en un celular compartido.
    maxAge: 12 * 60 * 60,
  },
  pages: {
    signIn: ROUTES.login,
    error: ROUTES.login,
  },
  trustHost: true,
  providers: [
    Credentials({
      credentials: {
        email: { label: 'Correo', type: 'email' },
        password: { label: 'Contraseña', type: 'password' },
      },
      /**
       * El límite de intentos va AQUÍ y no solo en la Server Action de login.
       *
       * `/api/auth/callback/credentials` es un endpoint público de NextAuth:
       * un atacante lo golpea directamente con curl y jamás pasa por nuestro
       * formulario. Un límite que solo viva en la Server Action protege
       * exactamente a quien no ataca.
       *
       * Devolver null (y no lanzar) hace que NextAuth responda con el error
       * genérico de credenciales, sin distinguir "no existe" de "clave mala"
       * ni revelar que se activó el límite.
       *
       * Ese silencio es correcto de cara al atacante y pésimo de cara a quien
       * depura: tras unos cuantos intentos fallidos, la contraseña CORRECTA
       * también devuelve CredentialsSignin, y desde fuera es indistinguible
       * de una credencial mala. De ahí el log: al cliente se le sigue dando
       * la misma respuesta opaca, pero en el servidor queda claro por qué.
       */
      authorize: async (credentials) => {
        const ip = clientIp(await headers())
        const limite = await checkRateLimit(`login:${ip}`, RATE_RULES.login)

        if (!limite.ok) {
          console.warn(
            `[auth] login bloqueado por rate limit — ip ${ip}, reintenta en ${limite.retryAfterSeconds}s. ` +
              'Ojo: con el límite activo, incluso la contraseña correcta se rechaza.',
          )
          return null
        }

        const user = await verifyCredentials(credentials)

        if (!user && process.env.NODE_ENV !== 'production') {
          // Solo en desarrollo: en producción esto sería una pista para quien
          // esté probando correos a ver cuáles existen.
          console.warn('[auth] credenciales incorrectas', {
            email: typeof credentials?.email === 'string' ? credentials.email : '(sin correo)',
            intentosRestantes: limite.remaining,
          })
        }

        return user
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user?.id) token.sub = user.id
      return token
    },
    session({ session, token }) {
      if (token.sub) session.user.id = token.sub
      return session
    },
  },
})
