import { headers } from 'next/headers'
import NextAuth from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import { verifyCredentialsDetailed } from '@/lib/credentials'
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
/**
 * Diagnóstico de arranque.
 *
 * Se ejecuta una vez al cargar el módulo y deja en el log de Vercel lo
 * mínimo para descartar los dos fallos de configuración más comunes, SIN
 * imprimir ningún valor secreto: solo si está presente y su longitud.
 */
if (!process.env.AUTH_SECRET && !process.env.NEXTAUTH_SECRET) {
  console.error(
    '[auth] FALTA AUTH_SECRET (ni NEXTAUTH_SECRET). Las cookies de sesión no ' +
      'se podrán firmar ni verificar: el login parecerá funcionar y rebotará ' +
      'al formulario. Añádela en Vercel, entorno Production.',
  )
} else {
  const fuente = process.env.AUTH_SECRET ? 'AUTH_SECRET' : 'NEXTAUTH_SECRET'
  const valor = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET!
  console.info('[auth] configuración', {
    secreto: `${fuente} presente (${valor.length} caracteres)`,
    authUrl: process.env.AUTH_URL ?? process.env.NEXTAUTH_URL ?? '(sin fijar: se deduce por trustHost)',
    trustHost: true,
    vercelEnv: process.env.VERCEL_ENV ?? '(no es Vercel)',
    vercelUrl: process.env.VERCEL_URL ?? '(sin VERCEL_URL)',
  })
}

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
        const t0 = Date.now()
        const correo =
          typeof credentials?.email === 'string' ? credentials.email : '(sin correo)'

        /**
         * `headers()` puede lanzar si Auth.js invoca authorize fuera del
         * ámbito de la petición. Si eso pasara, el throw subiría y NextAuth
         * respondería CredentialsSignin — otra forma de que un problema de
         * infraestructura se disfrace de contraseña mala. Se aísla.
         */
        let ip = 'desconocida'
        try {
          ip = clientIp(await headers())
        } catch (e) {
          console.error('[auth] no se pudo leer la IP del request', {
            error: e instanceof Error ? e.message : e,
          })
        }

        const limite = await checkRateLimit(`login:${ip}`, RATE_RULES.login)
        if (!limite.ok) {
          console.warn('[auth] RECHAZO: rate limit', {
            correo,
            ip,
            reintentarEnSegundos: limite.retryAfterSeconds,
            nota: 'con el límite activo, incluso la contraseña correcta se rechaza',
          })
          return null
        }

        const r = await verifyCredentialsDetailed(credentials)
        const ms = Date.now() - t0

        if (r.ok) {
          console.info('[auth] OK', { correo: r.user.email, userId: r.user.id, ms })
          return r.user
        }

        // Un fallo de base NO es culpa del usuario: se registra como error,
        // no como aviso, para que destaque en el panel de Vercel.
        if (r.reason === 'DATABASE_ERROR') {
          console.error('[auth] RECHAZO POR FALLO DE BASE DE DATOS', {
            correo,
            ms,
            detalle: r.detail,
            revisar: 'DATABASE_URL en Vercel (pooled, con pgbouncer=true&connection_limit=1)',
          })
          return null
        }

        console.warn('[auth] RECHAZO: credenciales', {
          correo,
          motivo: r.reason,
          ms,
          intentosRestantes: limite.remaining,
        })
        return null
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user?.id) token.sub = user.id
      /*
       * El rol se fija AL ENTRAR y no se refresca. Solo lo usa el proxy para
       * enrutar; la autorización la resuelve la base en cada petición.
       */
      const rol = (user as { role?: string } | undefined)?.role
      if (rol) token.role = rol as NonNullable<typeof token.role>
      if (!token.sub) {
        // Sin `sub` no hay sesión utilizable: todo lo que dependa de la
        // identidad fallará después sin decir por qué.
        console.error('[auth] callback jwt SIN sub', {
          tieneUser: Boolean(user),
          claves: Object.keys(token),
        })
      }
      return token
    },
    session({ session, token }) {
      if (!token.sub) {
        console.error('[auth] callback session: token sin sub', {
          nota: 'la cookie no se pudo descifrar o se firmó con otro AUTH_SECRET',
        })
      }
      if (token.sub) session.user.id = token.sub
      if (token.role) session.user.role = token.role as NonNullable<typeof session.user.role>
      // `iat` lo pone Auth.js al firmar. Viaja a la sesión para que
      // resolveTenantContext pueda descartar tokens emitidos antes del
      // último cambio de contraseña.
      if (typeof token.iat === 'number') session.issuedAt = token.iat
      return session
    },
  },
})
