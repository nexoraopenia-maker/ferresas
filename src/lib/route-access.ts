import type { Role } from '@/generated/prisma/enums'
import type { AccessLevel } from './tenant-context'

/**
 * Decisión de enrutado según sesión y estado de cuenta (§5.2, §5.3).
 *
 * Función PURA a propósito: el proxy queda como una cáscara de diez líneas y
 * toda la política de bloqueo se puede probar sin levantar Next ni Postgres.
 * Las reglas de acceso son justo el sitio donde un bug silencioso cuesta caro,
 * así que tienen que ser triviales de testear.
 *
 * ⚠️ ESTO NO ES LA FRONTERA DE SEGURIDAD. Es UX: evita que alguien vea una
 * pantalla que no le sirve. El enforcement real vive en getTenantPrisma(),
 * que bloquea la escritura aunque el usuario llegue a la ruta por la vía que
 * sea (fetch directo, Server Action invocada a mano, etc.).
 */

export const ROUTES = {
  login: '/login',
  dashboard: '/inventario',
  billing: '/facturacion',
  suspended: '/cuenta-suspendida',
  superadmin: '/superadmin',
} as const

export interface RouteSession {
  userId: string
  /** NULL solo para SUPERADMIN sin impersonar. */
  tenantId: string | null
  /**
   * Rol EFECTIVO. Durante una impersonation es el del usuario suplantado,
   * para que el soporte vea exactamente lo que ve el cliente.
   */
  role: Role
  access: AccessLevel
  /**
   * Id del SUPERADMIN real cuando hay impersonation en curso. Sin este campo
   * el soporte quedaría atrapado: su `role` efectivo sería OWNER y el guard
   * de /superadmin le cerraría la puerta de vuelta a su propio panel.
   */
  impersonatorId?: string
}

export type AccountNotice = 'WARN' | 'READ_ONLY'

/**
 * `allow` lleva el aviso como campo OPCIONAL en vez de partirse en dos
 * miembros con el mismo `kind`: una unión así no discrimina, y TypeScript
 * rechaza leer `.notice` incluso tras comprobar `kind === 'allow'`.
 */
export type RouteDecision =
  | { kind: 'allow'; notice?: AccountNotice }
  | { kind: 'redirect'; to: string; reason: string }
  /**
   * 404 indistinguible de una ruta inexistente (§5.3). Un `redirect` revelaría
   * que la ruta hace ALGO especial; un 404 no dice nada. El proxy lo sirve
   * reescribiendo a una ruta inexistente, de modo que el HTML resultante es
   * byte a byte el mismo que produce cualquier URL mal escrita.
   */
  | { kind: 'not-found'; reason: string }

/**
 * Rutas accesibles sin sesión.
 *
 * `/api/webhooks` DEBE estar aquí. Un webhook de Stripe llega sin cookie: si
 * el proxy lo redirigiera al login, el proveedor leería un 307 como fallo de
 * entrega, reintentaría, volvería a fallar y acabaría desactivando el
 * endpoint. El estado de suscripción se quedaría congelado para siempre y
 * nadie se enteraría hasta que un cliente reclamara.
 *
 * Su autenticación no es la sesión: es la FIRMA HMAC del proveedor, que se
 * verifica dentro del propio route handler.
 */
const PUBLIC_PREFIXES = [
  '/login',
  '/registro',
  '/api/auth',
  '/api/webhooks',
  // Vercel Cron invoca sin cookie. Se autentica con CRON_SECRET dentro del
  // propio handler, igual que los webhooks lo hacen con su firma HMAC.
  '/api/cron',
  '/legal',
]

/**
 * Rutas del área de negocio que siguen abiertas aunque la cuenta esté en
 * mora. Sin esto, un moroso no podría llegar a la pantalla donde paga —
 * que es exactamente lo contrario de lo que le conviene al SaaS.
 */
const ALWAYS_OPEN_FOR_TENANT = [
  '/facturacion',
  '/cuenta',
  '/logout',
  // Salir de una impersonation debe funcionar SIEMPRE, incluso si el tenant
  // suplantado está suspendido. Si no, el soporte se queda encerrado dentro
  // de la cuenta de un cliente bloqueado.
  '/salir-de-soporte',
]

function startsWithAny(pathname: string, prefixes: readonly string[]) {
  return prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`))
}

export function resolveRouteAccess(input: {
  pathname: string
  session: RouteSession | null
}): RouteDecision {
  const { pathname, session } = input

  // 1. Público: siempre pasa. Si ya hay sesión, el login redirige a su sitio.
  if (startsWithAny(pathname, PUBLIC_PREFIXES)) {
    if (session && pathname === ROUTES.login) {
      return {
        kind: 'redirect',
        to: session.tenantId ? ROUTES.dashboard : ROUTES.superadmin,
        reason: 'Ya tiene sesión iniciada.',
      }
    }
    return { kind: 'allow' }
  }

  // 2. Sin sesión: al login, conservando el destino.
  if (!session) {
    return {
      kind: 'redirect',
      to: `${ROUTES.login}?callbackUrl=${encodeURIComponent(pathname)}`,
      reason: 'Sin sesión.',
    }
  }

  const enSuperadmin = startsWithAny(pathname, [ROUTES.superadmin])

  // 3. Panel Super Admin (§5.3): invisible y no enrutable para clientes.
  //    Se responde 404, no una redirección: una redirección al dashboard le
  //    dice al curioso que esa URL recibe trato especial, y eso ya es una
  //    pista. El 404 la vuelve indistinguible de una ruta que no existe.
  if (enSuperadmin) {
    const esSuperadmin = session.role === 'SUPERADMIN' || session.impersonatorId != null
    if (!esSuperadmin) {
      return { kind: 'not-found', reason: 'No es superadmin.' }
    }
    return { kind: 'allow' }
  }

  // 3b. Salir de la impersonation: accesible mientras haya una en curso.
  if (pathname === '/salir-de-soporte') {
    return session.impersonatorId
      ? { kind: 'allow' }
      : { kind: 'not-found', reason: 'No hay impersonation activa.' }
  }

  // 4. Un SUPERADMIN sin tenant no tiene nada que hacer en el dashboard de
  //    cliente. Para entrar necesita impersonar (§5.3), y eso le asigna un
  //    tenantId de verdad.
  if (!session.tenantId) {
    return {
      kind: 'redirect',
      to: ROUTES.superadmin,
      reason: 'Sesión sin negocio asociado.',
    }
  }

  // 5. Suspensión por el Super Admin: nada excepto la pantalla informativa.
  //    Pagar no lo arregla, así que ni siquiera se le manda a facturación.
  if (session.access === 'BLOCKED') {
    if (pathname === ROUTES.suspended) return { kind: 'allow' }
    return { kind: 'redirect', to: ROUTES.suspended, reason: 'Cuenta suspendida.' }
  }

  // Ya no está suspendido: la pantalla de suspensión sobra.
  if (pathname === ROUTES.suspended) {
    return { kind: 'redirect', to: ROUTES.dashboard, reason: 'La cuenta ya no está suspendida.' }
  }

  // 6. Mora o cancelación: se puede seguir consultando y, sobre todo, pagando.
  //    Las escrituras las corta getTenantPrisma(), no el enrutado.
  if (session.access === 'READ_ONLY') {
    if (startsWithAny(pathname, ALWAYS_OPEN_FOR_TENANT)) return { kind: 'allow' }
    return { kind: 'allow', notice: 'READ_ONLY' }
  }

  if (session.access === 'WARN') {
    return { kind: 'allow', notice: 'WARN' }
  }

  return { kind: 'allow' }
}
