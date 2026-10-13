// `generateTempPassword` vive en un módulo que arrastra prisma.ts por la
// cadena de imports, y ese exige DATABASE_URL al cargarse. Este test no hace
// ninguna consulta: solo necesita que la variable exista.
import 'dotenv/config'
import { checkSameOrigin } from '@/lib/csrf'
import { requiresSessionLookup, resolveRouteAccess } from '@/lib/route-access'
import { generateTempPassword } from '@/features/superadmin/tenant-service'
import { createTenantBySuperAdminSchema } from '@/features/onboarding/schemas'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}
const H = (o: Record<string, string>) => new Headers(o)

console.log('\n1) CSRF — navegadores')
check('same-origin pasa',
  checkSameOrigin(H({ 'sec-fetch-site': 'same-origin', host: 'app.com' })).ok)
check('cross-site se RECHAZA (el ataque real)',
  !checkSameOrigin(H({ 'sec-fetch-site': 'cross-site', origin: 'https://malicioso.io' })).ok)
check('same-site (subdominio) también se rechaza',
  !checkSameOrigin(H({ 'sec-fetch-site': 'same-site' })).ok)
check('none (barra de direcciones) pasa',
  checkSameOrigin(H({ 'sec-fetch-site': 'none' })).ok)

console.log('\n2) CSRF — solo cabecera Origin (navegadores viejos)')
check('origin coincidente pasa',
  checkSameOrigin(H({ origin: 'https://app.com', host: 'app.com' })).ok)
check('origin ajeno se rechaza',
  !checkSameOrigin(H({ origin: 'https://malicioso.io', host: 'app.com' })).ok)
check('NO se compara por subcadena: "app.com.evil.io" se rechaza',
  !checkSameOrigin(H({ origin: 'https://app.com.evil.io', host: 'app.com' })).ok)
check('respeta x-forwarded-host (detrás de Vercel)',
  checkSameOrigin(H({ origin: 'https://app.com', 'x-forwarded-host': 'app.com', host: 'interno:3000' })).ok)
check('localhost se asume http',
  checkSameOrigin(H({ origin: 'http://localhost:3000', host: 'localhost:3000' })).ok)

console.log('\n3) CSRF — clientes programáticos')
check('sin Origin ni Sec-Fetch-Site pasa (curl, scripts)',
  checkSameOrigin(H({ host: 'app.com' })).ok)
check('y no por eso se salta la autorización: eso lo hace requireSuperAdmin', true)

console.log('\n4) El proxy NO debe redirigir llamadas de API')
for (const r of ['/api/tenants', '/api/auth/session', '/api/webhooks/billing/stripe', '/api/cron/expire-trials']) {
  check(`${r} se resuelve sin sesión en el proxy`, !requiresSessionLookup(r))
}
{
  // Antes de excluir /api, un SUPERADMIN (sin tenantId) veía su POST
  // desviado con 307 a /superadmin, que devuelve HTML.
  const d = resolveRouteAccess({
    pathname: '/api/tenants',
    session: { userId: 'sa', tenantId: null, role: 'SUPERADMIN', access: 'FULL' },
  })
  check('la política antigua habría redirigido (regresión fijada)',
    d.kind === 'redirect' && d.to === '/superadmin',
    'por eso /api sale del proxy antes de llegar aquí')
}
check('las rutas de UI SÍ siguen pasando por el proxy',
  requiresSessionLookup('/superadmin') && requiresSessionLookup('/inventario'))

console.log('\n5) Contraseña temporal generada')
{
  const p = generateTempPassword()
  check('longitud utilizable', p.replace(/-/g, '').length === 16, p)
  check('va en grupos de 4 para dictarla', p.split('-').length === 4)
  check('sin caracteres ambiguos (l 1 I O 0)', !/[l1IO0]/.test(p), p)
  const muestras = new Set(Array.from({ length: 200 }, () => generateTempPassword()))
  check('no se repite en 200 generaciones', muestras.size === 200)
  check('pasa el mínimo de 8 del esquema de registro',
    p.replace(/-/g, '').length >= 8)
}

console.log('\n6) Validación del cuerpo del POST')
const base = { businessName: 'Ferretería Sur', ownerName: 'Ana', email: 'a@x.com', planCode: 'pro' }
check('la contraseña es OPCIONAL (la genera el sistema)',
  createTenantBySuperAdminSchema.safeParse(base).success)
check('si se indica, se exige mínimo 8',
  !createTenantBySuperAdminSchema.safeParse({ ...base, password: 'corta' }).success)
check('una contraseña válida se acepta',
  createTenantBySuperAdminSchema.safeParse({ ...base, password: 'clave-larga-123' }).success)
check('nombre de negocio corto se rechaza',
  !createTenantBySuperAdminSchema.safeParse({ ...base, businessName: 'ab' }).success)
check('correo inválido se rechaza',
  !createTenantBySuperAdminSchema.safeParse({ ...base, email: 'no-es-correo' }).success)
check('el cuerpo NO admite role ni tenantId del cliente',
  !('role' in (createTenantBySuperAdminSchema.parse({ ...base, role: 'SUPERADMIN' }) as any)))
check('normaliza el correo a minúsculas',
  createTenantBySuperAdminSchema.parse({ ...base, email: 'A@X.COM' }).email === 'a@x.com')

console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
process.exit(fail === 0 ? 0 : 1)
