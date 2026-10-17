import type { DefaultSession } from 'next-auth'
import type { Role } from '@/generated/prisma/enums'

/**
 * El token de sesión lleva la IDENTIDAD y el rol DEL MOMENTO DEL LOGIN.
 *
 * El rol está aquí para que el proxy pueda enrutar sin consultar la base —
 * medido: esa consulta costaba 120-140 ms por navegación, porque el proxy
 * corre cerca del usuario y lejos de la base. Pero sigue sin ser la fuente
 * de verdad de la autorización: cada página y cada Server Action releen el
 * rol de la base. Si el del token y el de la base discrepan, manda la base.
 *
 * Consecuencia aceptada y documentada: ascender a alguien a SUPERADMIN exige
 * que vuelva a entrar para que el proxy le deje pasar a /superadmin. Degradar
 * surte efecto de inmediato, porque el enforcement lo hace la base.
 */
declare module 'next-auth' {
  interface Session {
    user: { id: string; role?: Role } & DefaultSession['user']
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
    /** Rol en el momento del login. Para enrutado, no para autorizar. */
    role?: Role
  }
}
