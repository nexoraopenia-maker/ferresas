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

/**
 * Rutas que NO necesitan resolver la sesión para decidir si pasan.
 *
 * ─── POR QUÉ EXISTE ESTA LISTA ───────────────────────────────────────────
 *
 * Resolver la sesión cuesta un `auth()` MÁS una consulta a Postgres. En un
 * servidor propio eso es despreciable; en Vercel + Neon no:
 *
 *   · Neon suspende el cómputo tras unos minutos de inactividad. La primera
 *     consulta después de un rato tarda segundos en despertarlo.
 *   · El proxy corre ANTES que el handler, así que ese retraso se paga en
 *     cada petición, incluida la POST de `/api/auth/callback/credentials`.
 *
 * Resultado: pulsas "Entrar" y la pantalla se queda colgada, porque antes de
 * validar la contraseña el proxy está esperando a que Neon despierte para
 * resolver una sesión que todavía no existe.
 *
 * Estas rutas se autentican por otra vía —firma HMAC los webhooks,
 * CRON_SECRET el cron, el propio NextAuth su callback— o son públicas, así
 * que la sesión no aporta nada a la decisión. Saltársela quita una consulta
 * del camino crítico del login.
 *
 * `/login` NO está aquí: sí necesita saber si ya hay sesión, para mandar al
 * usuario a su sitio en vez de enseñarle otra vez el formulario.
 */
const SKIP_SESSION_PREFIXES = [
  /**
   * TODA la superficie de API, sin excepción.
   *
   * No es solo rendimiento: el proxy no debe REDIRIGIR nunca una llamada de
   * API. Un cliente que hace POST /api/tenants y recibe un 307 hacia una
   * página HTML de login no tiene forma de entenderlo — espera JSON con un
   * código de estado. Antes de este cambio, un SUPERADMIN (que no tiene
   * tenantId) veía su propia llamada desviada a /superadmin por la regla que
   * saca del dashboard a las sesiones sin negocio.
   *
   * Cada handler bajo /api se autentica por su cuenta y con el mecanismo que
   * le toca: firma HMAC los webhooks, CRON_SECRET el cron, el propio NextAuth
   * su callback, y sesión + rol los endpoints de gestión.
   */
  '/api',
  '/registro',
  '/legal',
]

export function requiresSessionLookup(pathname: string): boolean {
  return !startsWithAny(pathname, SKIP_SESSION_PREFIXES)
}

/**
 * Puerta de CUENTA: lo que se decide con la sesión ya resuelta contra la base,
 * sin mirar la ruta.
 *
 * Se extrajo de `resolveRouteAccess` para que el layout del panel la aplique
 * tal cual. El layout no conoce el pathname —envuelve todas las rutas del
 * grupo— y sin esta separación habría tenido que reimplementar las mismas
 * reglas, dejando dos sitios que mantener sincronizados.
 *
 * `null` significa «adelante, sin aviso».
 */
export type AccountGate =
  | { kind: 'suspended' }
  | { kind: 'superadmin-sin-soporte' }
  | { kind: 'notice'; notice: AccountNotice }
  | null

export function resolveAccountGate(session: {
  role: Role
  tenantId: string | null
  access: AccessLevel
  impersonatorId?: string
}): AccountGate {
  // Suspensión por el Super Admin: manda sobre todo. Pagar no lo arregla, así
  // que ni siquiera se le manda a facturación.
  if (session.access === 'BLOCKED') return { kind: 'suspended' }

  // Un SUPERADMIN sin modo soporte no tiene nada que hacer en el panel de
  // cliente: para entrar necesita suplantar, y eso le da un tenantId.
  if (session.role === 'SUPERADMIN' && !session.impersonatorId) {
    return { kind: 'superadmin-sin-soporte' }
  }
  if (!session.tenantId) return { kind: 'superadmin-sin-soporte' }

  // Mora o cancelación: se puede seguir consultando y, sobre todo, pagando.
  // Las escrituras las corta getTenantPrisma(), no el enrutado.
  if (session.access === 'READ_ONLY') return { kind: 'notice', notice: 'READ_ONLY' }
  if (session.access === 'WARN') return { kind: 'notice', notice: 'WARN' }

  return null
}

/**
 * Política COMPLETA con la sesión resuelta contra la base.
 *
 * ⚠️ Ya NO la usa el proxy: el proxy decide solo con el token
 * (`resolveRouteAccessFromToken`) porque corre lejos de la base. Esta función
 * sigue viva como especificación completa de la política y es la que prueban
 * `tests/route-access.ts` y `tests/auth-session.ts`; su parte sin pathname
 * —`resolveAccountGate`— es la que aplica el layout del panel en cada
 * navegación real.
 */
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
  if (resolveAccountGate(session)?.kind === 'superadmin-sin-soporte') {
    return {
      kind: 'redirect',
      to: ROUTES.superadmin,
      reason: 'Sesión sin negocio asociado.',
    }
  }

  // 5-6. El resto lo decide la puerta de cuenta, compartida con el layout.
  const gate = resolveAccountGate(session)

  if (gate?.kind === 'suspended') {
    if (pathname === ROUTES.suspended) return { kind: 'allow' }
    return { kind: 'redirect', to: ROUTES.suspended, reason: 'Cuenta suspendida.' }
  }

  // Ya no está suspendido: la pantalla de suspensión sobra.
  if (pathname === ROUTES.suspended) {
    return { kind: 'redirect', to: ROUTES.dashboard, reason: 'La cuenta ya no está suspendida.' }
  }

  if (gate?.kind === 'notice') {
    // En mora se sigue pudiendo llegar a pagar: sin esto, el moroso no podría
    // entrar justo a la pantalla que le conviene.
    if (gate.notice === 'READ_ONLY' && startsWithAny(pathname, ALWAYS_OPEN_FOR_TENANT)) {
      return { kind: 'allow' }
    }
    return { kind: 'allow', notice: gate.notice }
  }

  return { kind: 'allow' }
}

// ═══════════════════════════════════════════════════════════════════════════
//  DECISIÓN SIN BASE DE DATOS (la que usa el proxy)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Lo que el proxy sabe SIN consultar la base: lo que viene firmado.
 *
 * `role` es el del momento del login y puede estar obsoleto. Solo se usa
 * para enrutar. `soporte` viene de un token firmado con su propia caducidad.
 */
export interface TokenSession {
  userId: string
  /**
   * Rol del JWT. Puede discrepar de la base; manda la base al renderizar.
   *
   * `undefined` en los tokens emitidos ANTES de que el rol empezara a viajar
   * en el JWT. No se trata como «rol mínimo»: se trata como «no se sabe», y
   * la decisión se delega en el render, que sí lee la base.
   *
   * La alternativa —asumir el rol más bajo— habría echado al login a todas
   * las sesiones abiertas el día del despliegue. Y delegar no debilita nada:
   * para /superadmin, el layout responde notFound() leyendo el rol REAL, que
   * es exactamente la misma respuesta que daría el proxy.
   */
  role?: Role
  /** Modo soporte vigente según el token firmado, ya verificado. */
  soporte?: { tenantId: string }
}

/**
 * Decisión de enrutado a partir SOLO del token.
 *
 * ─── POR QUÉ EL PROXY YA NO CONSULTA LA BASE ─────────────────────────────
 *
 * El proxy se despliega distribuido: corre cerca del USUARIO, no de la base.
 * Medido en producción, el proxy corría en `gru1` (São Paulo) mientras la
 * base está en `us-east-2` (Ohio), y `vercel.json → regions` NO lo cambia
 * (eso solo mueve las Vercel Functions). Resultado: su consulta de sesión
 * costaba ~120-140 ms en CADA navegación, y era el gasto mayor de la app.
 *
 * ─── QUÉ SE PIERDE, Y POR QUÉ ES ACEPTABLE ───────────────────────────────
 *
 * El proxy ya NO puede saber si el usuario fue desactivado, si el tenant está
 * suspendido o si la sesión quedó revocada por un cambio de contraseña: todo
 * eso vive en la base. Así que deja de poder redirigir por esos motivos.
 *
 * Es aceptable porque el proxy NUNCA fue la frontera de seguridad —lo dice la
 * cabecera de este archivo— y porque esas comprobaciones NO desaparecen: se
 * hacen al RENDERIZAR, en el layout y en cada página y Server Action, que
 * corren pegados a la base y ya resuelven la sesión (memoizada, una consulta).
 *
 * El cambio es DÓNDE se bloquea, no SI se bloquea. Un usuario desactivado ya
 * no recibe un 307 del proxy: recibe el redirect del layout. Llega un paso más
 * lejos y no ve nada que no deba ver.
 *
 * `tests/proxy-sin-bd.ts` comprueba los cuatro casos que deben seguir
 * bloqueados, y que ninguna ruta ni Server Action se salte la verificación.
 */
export function resolveRouteAccessFromToken(input: {
  pathname: string
  token: TokenSession | null
}): RouteDecision {
  const { pathname, token } = input

  // 1. Público: siempre pasa. Con sesión, el login manda a su sitio.
  if (startsWithAny(pathname, PUBLIC_PREFIXES)) {
    if (token && pathname === ROUTES.login) {
      return {
        kind: 'redirect',
        // Con el rol desconocido se manda al panel de cliente: si resultara
        // ser superadmin, su layout lo reenvía a /superadmin leyendo la base.
        to: token.role === 'SUPERADMIN' && !token.soporte ? ROUTES.superadmin : ROUTES.dashboard,
        reason: 'Ya tiene sesión iniciada.',
      }
    }
    return { kind: 'allow' }
  }

  // 2. Sin token: al login, conservando el destino.
  if (!token) {
    return {
      kind: 'redirect',
      to: `${ROUTES.login}?callbackUrl=${encodeURIComponent(pathname)}`,
      reason: 'Sin sesión.',
    }
  }

  /*
   * 3. Panel Super Admin: 404 para quien el TOKEN no acredita como superadmin.
   *
   * Un token obsoleto por ascenso deja fuera a un superadmin recién nombrado
   * hasta que vuelva a entrar; molesto pero seguro. Al revés —un degradado
   * cuyo token aún dice SUPERADMIN— el proxy le deja pasar y es el layout de
   * /superadmin el que responde notFound() leyendo la base. El 404 se
   * conserva en los dos casos, que es lo que evita confirmar que la ruta
   * existe.
   */
  if (startsWithAny(pathname, [ROUTES.superadmin])) {
    /*
     * Con el rol DESCONOCIDO se deja pasar y decide el layout, que lee el rol
     * real y responde notFound(). La respuesta es idéntica, así que no se
     * pierde la indistinguibilidad que protege la ruta; lo que se evita es
     * echar al login a las sesiones emitidas antes de este cambio.
     */
    const acreditado =
      token.role === undefined || token.role === 'SUPERADMIN' || token.soporte != null
    return acreditado
      ? { kind: 'allow' }
      : { kind: 'not-found', reason: 'El token no acredita superadmin.' }
  }

  // 3b. Salir del modo soporte: solo mientras haya uno vigente.
  if (pathname === '/salir-de-soporte') {
    return token.soporte
      ? { kind: 'allow' }
      : { kind: 'not-found', reason: 'No hay modo soporte activo.' }
  }

  /*
   * 4. Un SUPERADMIN sin modo soporte no tiene nada que hacer en el panel de
   *    cliente. Esto SÍ se puede decidir con el token: no depende de la base.
   */
  if (token.role === 'SUPERADMIN' && !token.soporte) {
    return {
      kind: 'redirect',
      to: ROUTES.superadmin,
      reason: 'Superadmin sin modo soporte.',
    }
  }
  // Con el rol desconocido NO se desvía: pasa y lo resuelve `guardDashboard`,
  // que lee la base y manda al superadmin a su panel si es el caso.

  /*
   * 5. Lo que queda —suspensión, mora, revocación por cambio de contraseña—
   *    depende de la base y lo resuelve el layout del panel. El proxy pasa.
   */
  return { kind: 'allow' }
}
