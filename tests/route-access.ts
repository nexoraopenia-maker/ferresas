import { resolveRouteAccess, ROUTES, type RouteSession } from '@/lib/route-access'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}

const sess = (o: Partial<RouteSession> = {}): RouteSession => ({
  userId: 'u1', tenantId: 't1', role: 'OWNER', access: 'FULL', ...o,
})
const at = (pathname: string, session: RouteSession | null = sess()) =>
  resolveRouteAccess({ pathname, session })

console.log('\n1) Rutas públicas y sesión ausente')
check('/login sin sesión pasa', at('/login', null).kind === 'allow')
check('/api/auth pasa sin sesión', at('/api/auth/callback/credentials', null).kind === 'allow')
check('/registro pasa sin sesión', at('/registro', null).kind === 'allow')
check('los webhooks NO se redirigen al login (Stripe llega sin cookie)',
  at('/api/webhooks/billing/stripe', null).kind === 'allow')
{
  const d = at('/inventario', null)
  check('ruta protegida sin sesión redirige al login', d.kind === 'redirect')
  check('conserva el destino en callbackUrl',
    d.kind === 'redirect' && d.to === '/login?callbackUrl=%2Finventario', d.kind === 'redirect' ? d.to : '')
}
{
  const d = at('/login', sess())
  check('con sesión, /login redirige al dashboard', d.kind === 'redirect' && d.to === ROUTES.dashboard)
}
{
  const d = at('/login', sess({ tenantId: null, role: 'SUPERADMIN' }))
  check('un superadmin logueado va a su panel desde /login',
    d.kind === 'redirect' && d.to === ROUTES.superadmin)
}

console.log('\n2) Panel Super Admin (§5.3): invisible para clientes')
check('SUPERADMIN entra', at('/superadmin', sess({ tenantId: null, role: 'SUPERADMIN' })).kind === 'allow')
{
  // 404 y no redirect: una redirección al dashboard le confirma al curioso
  // que esa URL recibe trato especial, y eso ya es una pista de que el panel
  // existe. El 404 la vuelve indistinguible de una ruta que no está.
  const d = at('/superadmin', sess({ role: 'OWNER' }))
  check('OWNER recibe 404, no una redirección', d.kind === 'not-found')
}
check('ADMIN tampoco entra', at('/superadmin/tenants', sess({ role: 'ADMIN' })).kind === 'not-found')
check('el guard cubre subrutas',
  at('/superadmin/tenants/123', sess({ role: 'VENDEDOR' })).kind === 'not-found')
check('el VENDEDOR tampoco lo ve',
  at('/superadmin', sess({ role: 'VENDEDOR' })).kind === 'not-found')

console.log('\n3) Superadmin sin tenant no entra al dashboard de cliente')
{
  const d = at('/inventario', sess({ tenantId: null, role: 'SUPERADMIN' }))
  check('se le devuelve a su panel', d.kind === 'redirect' && d.to === ROUTES.superadmin)
}

console.log('\n4) BLOCKED — suspensión por el Super Admin')
const blocked = sess({ access: 'BLOCKED' })
check('el dashboard queda cerrado', at('/inventario', blocked).kind === 'redirect')
check('facturación TAMBIÉN queda cerrada (pagar no levanta una suspensión)',
  at('/facturacion', blocked).kind === 'redirect')
check('solo ve la pantalla informativa', at('/cuenta-suspendida', blocked).kind === 'allow')

console.log('\n5) READ_ONLY — mora vencida o cancelación (§5.2)')
const ro = sess({ access: 'READ_ONLY' })
{
  const d = at('/inventario', ro)
  check('SÍ puede consultar el inventario', d.kind === 'allow')
  check('la UI recibe el aviso READ_ONLY', d.kind === 'allow' && d.notice === 'READ_ONLY')
}
check('facturación SIEMPRE abierta: es donde paga',
  at('/facturacion', ro).kind === 'allow')
{
  const d = at('/facturacion', ro)
  check('y sin banner encima, para no estorbar el pago',
    d.kind === 'allow' && d.notice === undefined)
}

console.log('\n6) WARN — dentro del período de gracia')
{
  const d = at('/inventario', sess({ access: 'WARN' }))
  check('opera con normalidad', d.kind === 'allow')
  check('pero con banner de aviso', d.kind === 'allow' && d.notice === 'WARN')
}

console.log('\n7) FULL — sin fricción')
{
  const d = at('/inventario', sess({ access: 'FULL' }))
  check('pasa sin aviso', d.kind === 'allow' && d.notice === undefined)
}
check('cuenta ya regularizada no se queda atrapada en /cuenta-suspendida',
  at('/cuenta-suspendida', sess({ access: 'FULL' })).kind === 'redirect')


async function bloque8() {
  console.log('\n8) Rutas que NO deben resolver sesión (bloqueo del login en Vercel)')
  const { requiresSessionLookup } = await import('@/lib/route-access')
  const sinSesion = [
    '/api/auth/callback/credentials',
    '/api/auth/csrf',
    '/api/auth/session',
    '/api/webhooks/billing/stripe',
    '/api/cron/expire-trials',
    '/registro',
    '/legal/terminos',
  ]
  for (const r of sinSesion) {
    check(`${r} se resuelve sin tocar la BD`, !requiresSessionLookup(r))
  }
  const conSesion = ['/login', '/inventario', '/facturacion', '/superadmin', '/']
  for (const r of conSesion) {
    check(`${r} sí necesita la sesión`, requiresSessionLookup(r))
  }
}

bloque8().then(() => {
  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  process.exit(fail === 0 ? 0 : 1)
})
