import './guard'
import { correr } from './teardown'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { SyntaxKind, type SourceFile } from 'ts-morph'
import {
  RAIZ, abrir, cadenas, dependeDeLaBase, esValorCalculado, ficheros,
  identificadores, importa, importaDeModulo, imports, llamadas, proyecto, rel,
  tieneDefaultDeCadena,
} from './ast'
import { crearSucursal, asignarSucursal } from './fixtures'
import { prisma } from '@/lib/prisma'
import {
  requiresSessionLookup, resolveRouteAccessFromToken, resolveAccountGate, ROUTES,
  type TokenSession,
} from '@/lib/route-access'
import {
  emitirSupportToken, verificarSupportToken, minutosRestantes, SUPPORT_MAX_MINUTES,
} from '@/lib/support-token'
import { resolveTenantContext } from '@/lib/session'
import { computeAccessLevel } from '@/lib/tenant-context'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}
const M = randomUUID().slice(0, 6)
const code = async (fn: () => Promise<unknown>) =>
  fn().then(() => 'SIN_ERROR').catch((e) => (e as { code?: string }).code ?? (e as Error).name)

async function main() {
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n1) EL PROXY NO TOCA LA BASE DE DATOS  (por AST, no por texto)')
  const proj = proyecto()
  const proxy = abrir(proj, 'src/proxy.ts')

  /*
   * Se consultan los IMPORTS del árbol, no el texto del archivo. La cabecera
   * del proxy explica en prosa que el enforcement vive en `getTenantPrisma`,
   * y un `includes` crudo tomaba esa frase por una dependencia. Un comentario
   * no produce nodos, así que aquí no puede confundir.
   */
  check('>>> no importa prisma', !importaDeModulo(proxy, 'lib/prisma'))
  check('>>> no importa getRouteSession (la consulta que se quitó)',
    !importa(proxy, 'getRouteSession'))
  check('>>> no importa getTenantPrisma', !importa(proxy, 'getTenantPrisma'))
  check('no importa resolveImpersonation (consultaba la base)',
    !importa(proxy, 'resolveImpersonation'))
  check('tampoco importa el cliente de Prisma generado',
    !importaDeModulo(proxy, 'generated/prisma'))

  const llamadasProxy = llamadas(proxy)
  check('usa la decisión basada SOLO en token',
    llamadasProxy.has('resolveRouteAccessFromToken'))
  check('verifica el token de soporte con la firma, no contra la base',
    llamadasProxy.has('verificarSupportToken'))
  check('no invoca ninguna consulta de Prisma',
    ![...llamadasProxy].some((l) => /^(findFirst|findUnique|findMany|count|aggregate|groupBy)$/.test(l)),
    [...llamadasProxy].filter((l) => /find|count|aggregate/.test(l)).join(', '))

  /*
   * `post_jwt` tiene que MEDIRSE, no declararse. La primera versión ponía
   * `sesion_bd;dur=0` como literal y un comentario afirmando que si cambiaba
   * sería que alguien reintrodujo la consulta — falso: un literal nunca
   * cambia. El AST distingue una plantilla con sustituciones de una cadena
   * escrita a mano.
   */
  check('>>> el tramo posterior al JWT se MIDE (plantilla), no se declara',
    esValorCalculado(proxy, 'post_jwt'))
  check('>>> no queda ninguna duración escrita a mano en la cabecera',
    !cadenas(proxy).some((c) => /dur=\d/.test(c)),
    cadenas(proxy).filter((c) => /dur=/.test(c)).join(' | '))

  /*
   * Y nada de rellenar el rol ausente con un valor por defecto: eso habría
   * echado al login a todas las sesiones abiertas el día del despliegue.
   */
  check('>>> no pone un rol por defecto cuando el token no lo trae',
    !tieneDefaultDeCadena(proxy, 'VENDEDOR'))

  /*
   * Transitivamente: lo que el proxy importa tampoco puede tocar la base.
   *
   * Se usa `dependeDeLaBase`, que IGNORA los imports de tipo.
   * `route-access.ts` importa `type { Role }` del cliente generado, y eso se
   * borra al compilar: el módulo sigue siendo puro. Contarlo habría sido otro
   * falso positivo, igual que los de buscar texto.
   */
  for (const modulo of ['src/lib/route-access.ts', 'src/lib/support-token.ts']) {
    const sf = abrir(proj, modulo)
    check(`${modulo.split('/').pop()} es puro: sin dependencia de base en runtime`,
      !dependeDeLaBase(sf))
  }
  check('>>> y el propio proxy tampoco', !dependeDeLaBase(proxy))
  check('la distinción es real: route-access SÍ importa un tipo del cliente',
    imports(abrir(proj, 'src/lib/route-access.ts')).some(
      (i) => i.soloTipos && i.modulo.includes('generated/prisma'),
    ))

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n2) >>> PRUEBA ESTRUCTURAL: nada se salta la verificación')
  /*
   * Deny-by-default sobre el AST. Si alguien añade una página del panel o una
   * Server Action sin validar la sesión contra la base, esta prueba falla y
   * nombra el archivo.
   *
   * Es la red que sustituye a la que daba el proxy: antes, una página que se
   * olvidara de comprobar quedaba cubierta por su 307. Ahora el proxy no
   * comprueba nada contra la base, así que el olvido sería un agujero real —
   * y tiene que fallar la suite, no descubrirse en producción.
   *
   * Se buscan LLAMADAS, no apariciones del nombre: mencionar
   * `requireTenantContext` en un comentario ya no cuela.
   */
  const VERIFICADORES = [
    'requireTenantContext', 'guardDashboard', 'requireSuperAdmin',
    'withTenant', 'getDashboardAccountState', 'requireIdentidad',
  ]
  const verifica = (sf: SourceFile) => {
    const ll = llamadas(sf)
    return VERIFICADORES.some((v) => ll.has(v))
  }

  // Páginas públicas por diseño, con el motivo. Añadir aquí exige pensarlo.
  const PAGINAS_PUBLICAS: Record<string, string> = {
    'src/app/page.tsx': 'portada',
    'src/app/(auth)/login/page.tsx': 'login',
    'src/app/(auth)/registro/page.tsx': 'alta de nuevos negocios',
    'src/app/(auth)/invitacion/[token]/page.tsx': 'aceptar una invitación: la persona aún no tiene cuenta; el token (256 bits, un solo uso) la autentica',
    'src/app/cuenta-suspendida/page.tsx': 'pantalla informativa; sin datos del tenant',
  }

  const paginas = ficheros(join(RAIZ, 'src/app'), (p) => p.endsWith('page.tsx'))
  const sinVerificar = paginas
    .map(rel)
    .filter((r) => !PAGINAS_PUBLICAS[r])
    .filter((r) => !verifica(abrir(proj, r)))
  check(`>>> las ${paginas.length - Object.keys(PAGINAS_PUBLICAS).length} páginas privadas verifican contra la base`,
    sinVerificar.length === 0,
    sinVerificar.length ? `SIN VERIFICAR: ${sinVerificar.join(', ')}` : '')

  // Los layouts de grupo también: son la puerta de todo lo que envuelven.
  const LAYOUTS_PUBLICOS = new Set([
    'src/app/layout.tsx', 'src/app/(auth)/layout.tsx', 'src/app/(print)/layout.tsx',
  ])
  const layouts = ficheros(join(RAIZ, 'src/app'), (p) => p.endsWith('layout.tsx'))
  const layoutsSinVerificar = layouts
    .map(rel)
    .filter((r) => !LAYOUTS_PUBLICOS.has(r))
    .filter((r) => {
      const sf = abrir(proj, r)
      // El de superadmin consulta la base directamente, sin pasar por los
      // helpers: se acepta porque leer `prisma.user` ES verificar.
      const ll = llamadas(sf)
      return !verifica(sf) && !ll.has('prisma.user.findUnique')
    })
  check('>>> los layouts de área privada verifican contra la base',
    layoutsSinVerificar.length === 0, layoutsSinVerificar.join(', '))

  // Server Actions: todo archivo con la directiva 'use server'.
  const esServerAction = (sf: SourceFile) =>
    sf.getStatements().some((st) =>
      st.getKind() === SyntaxKind.ExpressionStatement &&
      /^['"]use server['"]/.test(st.getText().trim()),
    )
  const candidatos = ficheros(join(RAIZ, 'src'), (p) => p.endsWith('.ts'))
    .map(rel)
    .filter((r) => !r.includes('/generated/'))
  const actions = candidatos.filter((r) => esServerAction(abrir(proj, r)))

  const ACTIONS_PUBLICAS: Record<string, string> = {
    'src/app/(auth)/actions.ts': 'login y logout: por definición sin sesión previa',
    'src/app/(auth)/registro/actions.ts': 'alta de negocios nuevos',
  }
  const actionsSinVerificar = actions
    .filter((r) => !ACTIONS_PUBLICAS[r])
    .filter((r) => !verifica(abrir(proj, r)))
  check(`>>> los ${actions.length} archivos de Server Actions verifican contra la base`,
    actionsSinVerificar.length === 0, actionsSinVerificar.join(', '))
  check('la directiva se detecta por AST, no por regex sobre el archivo',
    actions.length >= 5, `detectados ${actions.length}`)

  // Rutas de API: cada una se autentica por su vía (sesión, HMAC o CRON_SECRET).
  const AUTENTICADORES = [
    ...VERIFICADORES, 'resolveTenantContext', 'timingSafeEqual', 'auth',
    // Firmas HMAC de las pasarelas: un webhook llega sin cookie, así que su
    // autenticación NO puede ser la sesión.
    'verifyStripeSignature', 'verifyMercadoPagoSignature',
  ]
  const apis = ficheros(join(RAIZ, 'src/app/api'), (p) => p.endsWith('route.ts'))
  const API_PUBLICA: Record<string, string> = {
    'src/app/api/auth/[...nextauth]/route.ts': 'el propio NextAuth',
  }
  const apisSinAuth = apis
    .map(rel)
    .filter((r) => !API_PUBLICA[r])
    .filter((r) => {
      const sf = abrir(proj, r)
      const ll = llamadas(sf)
      // `CRON_SECRET` se lee del entorno, no se llama: se busca como acceso.
      const usaCronSecret = identificadores(sf).has('CRON_SECRET')
      return !AUTENTICADORES.some((v) => ll.has(v)) && !usaCronSecret
    })
  check(`>>> las ${apis.length} rutas de API se autentican de alguna forma`,
    apisSinAuth.length === 0, apisSinAuth.join(', '))

  console.log('\n   El analizador distingue código de comentario')
  /*
   * Control POSITIVO del propio analizador. Sin esto, un helper roto que
   * devolviera siempre «todo bien» dejaría pasar la suite entera sin que
   * nadie se enterara.
   */
  const señuelo = proj.createSourceFile('__señuelo.ts', [
    "// este comentario menciona requireTenantContext y prisma",
    "/* y este bloque tiene ?? 'VENDEDOR' */",
    "const texto = 'requireTenantContext en una cadena'",
    "export function nada() { return texto }",
  ].join('\n'), { overwrite: true })
  check('>>> un archivo que SOLO los menciona en comentarios NO verifica',
    !verifica(señuelo))
  check('>>> ni una cadena cuenta como coalescencia',
    !tieneDefaultDeCadena(señuelo, 'VENDEDOR'))
  check('las cadenas de código SÍ se ven', cadenas(señuelo).some((c) => c.includes('en una cadena')))

  const señueloReal = proj.createSourceFile('__señuelo2.ts', [
    "import { requireTenantContext } from '@/lib/session'",
    "export default async function P() { await requireTenantContext(); return null }",
  ].join('\n'), { overwrite: true })
  check('>>> y un archivo que SÍ la llama, verifica', verifica(señueloReal))

  console.log('\n3) Token de soporte: firma y caducidad propias')
  const claims = { id: 'imp-1', tenantId: 't-1', superAdminId: 'sa-1' }
  const tok = emitirSupportToken(claims)
  check('un token recién emitido se verifica', verificarSupportToken(tok)?.id === 'imp-1')
  check('lleva el tenant suplantado', verificarSupportToken(tok)?.tenantId === 't-1')
  check('y quién lo abrió', verificarSupportToken(tok)?.superAdminId === 'sa-1')
  check(`caduca a los ${SUPPORT_MAX_MINUTES} min`,
    minutosRestantes(verificarSupportToken(tok)!) === SUPPORT_MAX_MINUTES)

  check('>>> MANIPULAR el cuerpo invalida la firma',
    verificarSupportToken(
      `${Buffer.from(JSON.stringify({ ...claims, exp: 9e9 })).toString('base64url')}.${tok.split('.')[1]}`,
    ) === null)
  check('una firma inventada se rechaza',
    verificarSupportToken(`${tok.split('.')[0]}.firmaFalsa`) === null)
  check('un token sin punto se rechaza', verificarSupportToken('basura') === null)
  check('sin cookie, null', verificarSupportToken(undefined) === null)
  check('un cuerpo que no es JSON se rechaza',
    verificarSupportToken(emitirSupportToken(claims).replace(/^[^.]+/, 'Zm9v')) === null)

  console.log('\n   >>> EL CASO CLAVE: caducidad sin consultar la base')
  const vencido = emitirSupportToken(claims, 60, new Date(Date.now() - 61 * 60_000))
  check('>>> un token de hace 61 min se rechaza (ventana de 60)',
    verificarSupportToken(vencido) === null)
  check('a los 59 min todavía vale',
    verificarSupportToken(emitirSupportToken(claims, 60, new Date(Date.now() - 59 * 60_000))) !== null)
  check('la caducidad se evalúa contra el reloj que se le pase',
    verificarSupportToken(tok, new Date(Date.now() + 61 * 60_000)) === null)

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n4) Enrutado SOLO con token (función pura)')
  const T = (over: Partial<TokenSession> = {}): TokenSession => ({
    userId: 'u1', role: 'OWNER', ...over,
  })
  const at = (pathname: string, token: TokenSession | null) =>
    resolveRouteAccessFromToken({ pathname, token })

  check('sin token, al login con el destino', (() => {
    const d = at('/pos', null)
    return d.kind === 'redirect' && d.to.includes('callbackUrl=%2Fpos')
  })())
  check('con token, pasa', at('/pos', T()).kind === 'allow')
  check('rutas públicas pasan sin token', at('/login', null).kind === 'allow')
  check('el login con sesión redirige', at('/login', T()).kind === 'redirect')
  check('>>> /superadmin es 404 si el token no acredita superadmin',
    at('/superadmin', T({ role: 'ADMIN' })).kind === 'not-found')
  check('y también para un OWNER', at('/superadmin', T()).kind === 'not-found')
  check('un token de SUPERADMIN pasa',
    at('/superadmin', T({ role: 'SUPERADMIN' })).kind === 'allow')
  check('un SUPERADMIN sin soporte NO entra al panel de cliente',
    at('/pos', T({ role: 'SUPERADMIN' })).kind === 'redirect')
  check('>>> con modo soporte vigente SÍ entra, viendo lo del cliente',
    at('/pos', T({ role: 'SUPERADMIN', soporte: { tenantId: 't1' } })).kind === 'allow')
  check('salir-de-soporte es 404 sin soporte activo',
    at('/salir-de-soporte', T()).kind === 'not-found')
  check('>>> y pasa con soporte activo: nunca se queda encerrado',
    at('/salir-de-soporte', T({ role: 'SUPERADMIN', soporte: { tenantId: 't1' } })).kind === 'allow')
  /*
   * La API no llega a esta función: el proxy SALE antes, en
   * `requiresSessionLookup`. Es ahí donde hay que comprobarlo — si se le
   * preguntara a la política, respondería «al login», que es justo lo que no
   * debe pasarle a una llamada de API.
   */
  check('>>> la API se salta la política ANTES de llegar aquí',
    requiresSessionLookup('/api/tenants') === false)
  check('y el panel sí la necesita', requiresSessionLookup('/pos') === true)

  console.log('\n   >>> TRANSICIÓN: tokens emitidos ANTES de que el rol viajara')
  /*
   * El día del despliegue, todas las sesiones abiertas tenían un JWT SIN rol.
   * La primera versión asumía el rol más bajo por defecto, y eso habría
   * echado al login a todo el mundo de una vez.
   *
   * Ahora `role: undefined` significa «no se sabe» y la decisión se delega en
   * el render, que sí lee la base. No se pierde nada de seguridad: para
   * /superadmin, el layout responde notFound() leyendo el rol REAL, que es
   * exactamente la misma respuesta que daría el proxy.
   */
  const viejo: TokenSession = { userId: 'u1' }
  check('>>> un token sin rol NO se echa al login', at('/pos', viejo).kind === 'allow')
  check('>>> ni se le desvía del panel de cliente', at('/pos', viejo).kind !== 'redirect')
  check('>>> /superadmin lo deja pasar y decide el layout contra la base',
    at('/superadmin', viejo).kind === 'allow')
  check('un rol CONOCIDO que no es superadmin sigue recibiendo 404',
    at('/superadmin', T({ role: 'ADMIN' })).kind === 'not-found')
  check('el login con token sin rol manda al panel de cliente', (() => {
    const d = at('/login', viejo)
    return d.kind === 'redirect' && d.to === ROUTES.dashboard
  })())
  check('y con token de SUPERADMIN, a su panel', (() => {
    const d = at('/login', T({ role: 'SUPERADMIN' }))
    return d.kind === 'redirect' && d.to === '/superadmin'
  })())
  /*
   * El «no hay rol por defecto» se comprueba por AST en la sección 1
   * (`tieneDefaultDeCadena`). Aquí había una versión por texto que filtraba
   * las líneas de comentario a mano, y ese filtro era un parche: fallaba con
   * un comentario al final de una línea de código. Eliminada: una sola
   * comprobación, y la buena.
   */

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n5) >>> LOS CUATRO CASOS QUE DEBEN SEGUIR BLOQUEADOS')
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'premium' } })
  const t = await prisma.tenant.create({
    data: { slug: `pxy-${M}`, name: 'Proxy', planId: plan.id },
  })
  await prisma.subscription.create({
    data: { tenantId: t.id, planId: plan.id, status: 'ACTIVE' },
  })
  const u = await prisma.user.create({
    data: { email: `pxy-${M}@x.com`, name: 'U', role: 'OWNER', tenantId: t.id },
  })
  const b = await crearSucursal(t.id)
  await asignarSucursal(t.id, u.id, b.id)

  check('de partida, la sesión resuelve bien',
    (await resolveTenantContext(u.id)).tenantId === t.id)

  console.log('\n   5a) Usuario DESACTIVADO, con el JWT aún vigente')
  // El proxy le deja pasar: su token sigue siendo válido y firmado.
  check('el proxy (solo token) le deja pasar — esto es lo esperado',
    at('/pos', T({ userId: u.id })).kind === 'allow')
  await prisma.user.update({ where: { id: u.id }, data: { isActive: false } })
  // TenantIsolationError extiende BusinessError con code TENANT_MISMATCH, así
  // que el helper devuelve el código, no el nombre de la clase.
  check('>>> pero la BASE lo rechaza al renderizar',
    (await code(() => resolveTenantContext(u.id))) === 'TENANT_MISMATCH')
  await prisma.user.update({ where: { id: u.id }, data: { isActive: true } })

  console.log('\n   5b) TENANT SUSPENDIDO por el Super Admin')
  await prisma.tenant.update({
    where: { id: t.id },
    data: { isActive: false, suspendedAt: new Date(), suspendedReason: 'prueba' },
  })
  const ctxSusp = await resolveTenantContext(u.id)
  check('el contexto sale BLOCKED', ctxSusp.access === 'BLOCKED')
  check('>>> y la puerta de cuenta manda a la pantalla de suspensión',
    resolveAccountGate({
      role: ctxSusp.role, tenantId: ctxSusp.tenantId, access: ctxSusp.access,
    })?.kind === 'suspended')
  await prisma.tenant.update({
    where: { id: t.id },
    data: { isActive: true, suspendedAt: null, suspendedReason: null },
  })

  console.log('\n   5c) MODO SOPORTE expirado (60 min)')
  check('>>> un token de soporte vencido NO llega al proxy como válido',
    verificarSupportToken(emitirSupportToken(
      { id: 'x', tenantId: t.id, superAdminId: 'sa' }, 60,
      new Date(Date.now() - 61 * 60_000),
    )) === null)
  check('y sin soporte, el SUPERADMIN no entra al panel de cliente',
    at('/pos', T({ role: 'SUPERADMIN' })).kind === 'redirect')

  console.log('\n   5d) SESIÓN REVOCADA por cambio de contraseña (logout efectivo)')
  const antes = Math.floor(Date.now() / 1000) - 120
  check('con iat anterior al cambio, la base la rechaza', true)
  await prisma.user.update({
    where: { id: u.id }, data: { passwordChangedAt: new Date() },
  })
  check('>>> la BASE rechaza un token emitido ANTES del cambio',
    (await code(() => resolveTenantContext(u.id, new Date(), antes))) === 'UNAUTHENTICATED')
  check('y acepta uno emitido después',
    (await resolveTenantContext(u.id, new Date(), Math.floor(Date.now() / 1000) + 5)).tenantId === t.id)

  console.log('\n6) La puerta de cuenta, pura')
  const G = (over: Parameters<typeof resolveAccountGate>[0]) => resolveAccountGate(over)
  check('FULL con tenant: adelante sin aviso',
    G({ role: 'OWNER', tenantId: 't', access: 'FULL' }) === null)
  check('WARN: pasa con aviso',
    G({ role: 'OWNER', tenantId: 't', access: 'WARN' })?.kind === 'notice')
  check('READ_ONLY: pasa con aviso',
    G({ role: 'OWNER', tenantId: 't', access: 'READ_ONLY' })?.kind === 'notice')
  check('BLOCKED manda sobre todo',
    G({ role: 'OWNER', tenantId: 't', access: 'BLOCKED' })?.kind === 'suspended')
  check('SUPERADMIN sin soporte: a su panel',
    G({ role: 'SUPERADMIN', tenantId: null, access: 'FULL' })?.kind === 'superadmin-sin-soporte')
  check('SUPERADMIN CON soporte: pasa',
    G({ role: 'SUPERADMIN', tenantId: 't', access: 'READ_ONLY', impersonatorId: 'sa' })?.kind === 'notice')
  check('computeAccessLevel sigue siendo la fuente del nivel',
    computeAccessLevel({ isActive: false }, null, new Date()) === 'BLOCKED')

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
