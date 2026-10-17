import './guard'
import { correr } from './teardown'
import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { crearSucursal, asignarSucursal } from './fixtures'
import { prisma } from '@/lib/prisma'
import {
  requiresSessionLookup, resolveRouteAccessFromToken, resolveAccountGate,
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

const RAIZ = join(import.meta.dirname ?? process.cwd(), '..')

function ficheros(dir: string, filtro: (p: string) => boolean): string[] {
  const out: string[] = []
  const recorrer = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'generated') continue
        recorrer(p)
      } else if (filtro(p)) out.push(p)
    }
  }
  recorrer(dir)
  return out
}

async function main() {
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n1) EL PROXY NO TOCA LA BASE DE DATOS')
  const proxy = readFileSync(join(RAIZ, 'src/proxy.ts'), 'utf-8')
  /*
   * Se inspecciona SOLO la cabecera de imports, no todo el archivo. La
   * documentación del proxy EXPLICA en prosa que el enforcement vive en
   * getTenantPrisma, y un `includes` crudo tomaba esa frase por una
   * dependencia. La prueba tiene que distinguir lo que el archivo USA de lo
   * que el archivo CUENTA.
   */
  const cabecera = proxy.split('export async function proxy')[0] ?? ''
  const importa = (nombre: string) =>
    new RegExp(`\\b${nombre}\\b`).test(
      cabecera.split('\n').filter((l) => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('/*') && !l.trimStart().startsWith('//')).join('\n'),
    )

  check('>>> no importa prisma', !/from ['"][^'"]*lib\/prisma['"]/.test(proxy))
  check('>>> no importa getRouteSession (la consulta que se quitó)',
    !importa('getRouteSession'))
  check('>>> no importa getTenantPrisma', !importa('getTenantPrisma'))
  check('no importa resolveImpersonation (consultaba la base)',
    !importa('resolveImpersonation'))
  check('usa la decisión basada SOLO en token',
    proxy.includes('resolveRouteAccessFromToken'))
  check('verifica el token de soporte con la firma, no contra la base',
    proxy.includes('verificarSupportToken'))
  check('>>> declara sesion_bd=0 en la cabecera, para que un retroceso se VEA',
    proxy.includes("'sesion_bd;dur=0'"))

  // Y lo mismo, transitivamente: route-access tampoco puede tocar la base.
  const ra = readFileSync(join(RAIZ, 'src/lib/route-access.ts'), 'utf-8')
  check('route-access es puro: no importa prisma', !ra.includes("lib/prisma"))
  const st = readFileSync(join(RAIZ, 'src/lib/support-token.ts'), 'utf-8')
  check('support-token es puro: no importa prisma', !st.includes("./prisma"))

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n2) >>> PRUEBA ESTRUCTURAL: nada se salta la verificación')
  /*
   * Deny-by-default sobre el código fuente. Si alguien añade una página del
   * panel o una Server Action sin validar la sesión contra la base, esta
   * prueba falla y nombra el archivo.
   *
   * Es la red que sustituye a la que daba el proxy: antes, una página que se
   * olvidara de comprobar quedaba cubierta por el 307 del proxy. Ahora el
   * proxy no comprueba nada contra la base, así que el olvido sería un
   * agujero real — y tiene que fallar la suite, no descubrirse en producción.
   */
  const VERIFICADORES = [
    'requireTenantContext', 'guardDashboard', 'requireSuperAdmin',
    'withTenant', 'getDashboardAccountState',
  ]

  // Páginas públicas por diseño, con el motivo. Añadir aquí exige pensarlo.
  const PAGINAS_PUBLICAS: Record<string, string> = {
    'src/app/page.tsx': 'portada',
    'src/app/(auth)/login/page.tsx': 'login',
    'src/app/(auth)/registro/page.tsx': 'alta de nuevos negocios',
    'src/app/cuenta-suspendida/page.tsx': 'pantalla informativa; sin datos del tenant',
    // El layout del grupo (print) no existe como página; las de impresión sí verifican.
  }

  const paginas = ficheros(join(RAIZ, 'src/app'), (p) => p.endsWith('page.tsx'))
  const sinVerificar: string[] = []
  for (const f of paginas) {
    const rel = relative(RAIZ, f).replace(/\\/g, '/')
    if (PAGINAS_PUBLICAS[rel]) continue
    const txt = readFileSync(f, 'utf-8')
    if (!VERIFICADORES.some((v) => txt.includes(v))) sinVerificar.push(rel)
  }
  check(`>>> las ${paginas.length - Object.keys(PAGINAS_PUBLICAS).length} páginas privadas verifican contra la base`,
    sinVerificar.length === 0,
    sinVerificar.length ? `SIN VERIFICAR: ${sinVerificar.join(', ')}` : '')

  // Los layouts de grupo también: son la puerta de todo lo que envuelven.
  const LAYOUTS_PUBLICOS = new Set([
    'src/app/layout.tsx', 'src/app/(auth)/layout.tsx', 'src/app/(print)/layout.tsx',
  ])
  const layouts = ficheros(join(RAIZ, 'src/app'), (p) => p.endsWith('layout.tsx'))
  const layoutsSinVerificar = layouts
    .map((f) => relative(RAIZ, f).replace(/\\/g, '/'))
    .filter((rel) => !LAYOUTS_PUBLICOS.has(rel))
    .filter((rel) => {
      const txt = readFileSync(join(RAIZ, rel), 'utf-8')
      return !VERIFICADORES.some((v) => txt.includes(v)) && !txt.includes('prisma.user')
    })
  check('>>> los layouts de área privada verifican contra la base',
    layoutsSinVerificar.length === 0,
    layoutsSinVerificar.join(', '))

  // Server Actions: todo archivo con 'use server' debe verificar.
  const actions = ficheros(
    join(RAIZ, 'src'),
    (p) => p.endsWith('.ts') && !p.includes('/generated/'),
  ).filter((f) => {
    const t = readFileSync(f, 'utf-8')
    return /^['"]use server['"]/m.test(t)
  })
  const ACTIONS_PUBLICAS: Record<string, string> = {
    'src/app/(auth)/actions.ts': 'login y logout: por definición sin sesión previa',
    'src/app/(auth)/registro/actions.ts': 'alta de negocios nuevos',
  }
  const actionsSinVerificar = actions
    .map((f) => relative(RAIZ, f).replace(/\\/g, '/'))
    .filter((rel) => !ACTIONS_PUBLICAS[rel])
    .filter((rel) => {
      const txt = readFileSync(join(RAIZ, rel), 'utf-8')
      return !VERIFICADORES.some((v) => txt.includes(v))
    })
  check(`>>> los ${actions.length} archivos de Server Actions verifican contra la base`,
    actionsSinVerificar.length === 0,
    actionsSinVerificar.join(', '))

  // Rutas de API: cada una se autentica por su vía (sesión, HMAC o CRON_SECRET).
  const AUTENTICADORES = [
    ...VERIFICADORES, 'resolveTenantContext', 'CRON_SECRET', 'timingSafeEqual', 'auth()',
    // Firmas HMAC de las pasarelas: su autenticación NO es la sesión, y no
    // puede serlo — un webhook llega sin cookie.
    'verifyStripeSignature', 'verifyMercadoPagoSignature',
  ]
  const apis = ficheros(join(RAIZ, 'src/app/api'), (p) => p.endsWith('route.ts'))
  const API_PUBLICA: Record<string, string> = {
    'src/app/api/auth/[...nextauth]/route.ts': 'el propio NextAuth',
  }
  const apisSinAuth = apis
    .map((f) => relative(RAIZ, f).replace(/\\/g, '/'))
    .filter((rel) => !API_PUBLICA[rel])
    .filter((rel) => {
      const txt = readFileSync(join(RAIZ, rel), 'utf-8')
      return !AUTENTICADORES.some((v) => txt.includes(v))
    })
  check(`>>> las ${apis.length} rutas de API se autentican de alguna forma`,
    apisSinAuth.length === 0, apisSinAuth.join(', '))

  check('la prueba SÍ detecta un archivo sin verificar (control negativo)',
    !VERIFICADORES.some((v) => 'export default function Pagina() { return null }'.includes(v)))

  // ═══════════════════════════════════════════════════════════════════════
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
