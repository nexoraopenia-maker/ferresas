import type { DefaultSession } from 'next-auth'

/**
 * El token de sesión lleva SOLO la identidad (quién es), nunca la
 * autorización (qué puede hacer). Ver la nota en src/auth.ts.
 */
declare module 'next-auth' {
  interface Session {
    user: { id: string } & DefaultSession['user']
    /**
     * Segundos epoch en que se emitió el JWT (`iat`). Se usa para revocar
     * sesiones anteriores a un cambio de contraseña; sin él, cambiar la
     * contraseña no echaría a nadie.
     */
    issuedAt?: number
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    sub?: string
  }
}
