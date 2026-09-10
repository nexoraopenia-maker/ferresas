import type { DefaultSession } from 'next-auth'

/**
 * El token de sesión lleva SOLO la identidad (quién es), nunca la
 * autorización (qué puede hacer). Ver la nota en src/auth.ts.
 */
declare module 'next-auth' {
  interface Session {
    user: { id: string } & DefaultSession['user']
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    sub?: string
  }
}
