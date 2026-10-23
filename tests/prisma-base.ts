import { join } from 'node:path'
import { SyntaxKind } from 'ts-morph'
import { ficheros, proyecto, RAIZ, rel } from './ast'

/**
 * Inventario de usos del cliente Prisma BASE y de SQL directo.
 *
 * ─── POR QUÉ EXISTE ──────────────────────────────────────────────────────
 *
 * El aislamiento por negocio lo hace `getTenantPrisma`: filtra por `tenantId` y
 * por sucursal, y bloquea lo que no declara a qué negocio escribe. Pero NO hay
 * RLS de Postgres (decisión aplazada): quien use el `prisma` base, o `$queryRaw`,
 * se salta esa red por completo. Eso es legítimo en unos pocos sitios (el login,
 * el panel maestro, un cron entre negocios...) y un agujero en cualquier otro.
 *
 * Esta prueba obliga a que CADA archivo que lo use esté en esta lista, con su
 * motivo. Añadir uno exige escribirlo aquí y, con ello, pensarlo. Y vuelve a
 * fallar si un archivo de la lista ya no lo usa (la lista no se pudre).
 */

/** Archivos que importan el cliente `prisma` base. */
const BASE: Record<string, string> = {
  // — Identidad: se resuelve ANTES de saber a qué negocio pertenece la petición —
  'src/lib/credentials.ts': 'login: busca al usuario por correo, antes de que exista contexto de negocio',
  'src/lib/session.ts': 'resuelve la sesión y construye el TenantContext (el origen del aislamiento)',
  'src/lib/tenant-prisma.ts': 'es el propio cliente aislado: envuelve al base',
  'src/lib/impersonation.ts': 'soporte: valida la sesión de suplantación del SuperAdmin',
  'src/features/seguridad/dispositivos.ts': 'sesiones por dispositivo: ligadas al usuario, no a un negocio concreto',
  'src/features/seguridad/pin-service.ts': 'PIN de cajero: se verifica y bloquea por usuario',
  'src/features/seguridad/mfa-service.ts': 'segundo factor: por usuario, con SQL atómico (array_remove) para los códigos de recuperación',
  'src/features/usuarios/service.ts': 'aceptar una invitación: la persona aún no tiene cuenta ni contexto; el token la autentica',
  // — Alta de negocios y datos de demostración —
  'src/app/(auth)/registro/actions.ts': 'alta de un negocio nuevo: todavía no existe tenant',
  'src/features/onboarding/service.ts': 'crea el tenant, su dueño y su sucursal',
  'src/features/demo/seed.ts': 'siembra una cuenta de DEMOSTRACIÓN (isDemo), nunca un negocio real',
  'src/features/demo/arranque.ts': 'dispara la siembra de la demo al entrar con su correo',
  // — Procesos entre negocios y pasarelas —
  'src/features/billing/expire-trials.ts': 'cron: recorre TODOS los negocios con prueba vencida',
  'src/features/billing/webhook-service.ts': 'webhooks de la pasarela de pago: el negocio se identifica por la referencia externa',
  // — Panel maestro (solo SUPERADMIN, tras requireSuperAdmin) —
  'src/app/(superadmin)/layout.tsx': 'guarda del panel maestro',
  'src/app/(superadmin)/superadmin/page.tsx': 'panel maestro',
  'src/features/superadmin/actions.ts': 'acciones del panel maestro',
  'src/features/superadmin/queries.ts': 'consultas del panel maestro (todos los negocios)',
  'src/features/superadmin/account-service.ts': 'cuenta del propio SuperAdmin',
  'src/features/superadmin/billing-service.ts': 'planes y cobros de los negocios',
  'src/features/superadmin/tenant-admin-service.ts': 'restablecer contraseña y editar el perfil de un negocio',
  'src/features/superadmin/facturacion-real-service.ts': 'interruptor de facturación real: único código que lo escribe',
  'src/features/superadmin/components/ImpersonationBanner.tsx': 'banner de soporte (componente de servidor): lee la sesión de suplantación',
  // — Diagnóstico (protegido por CRON_SECRET) y catálogo global —
  'src/app/api/diagnostics/route.ts': 'estado del sistema, protegido por CRON_SECRET; sin datos de negocios',
  'src/app/api/diagnostics/perf/route.ts': 'mediciones de rendimiento, protegido por CRON_SECRET',
  'src/features/ubigeo/service.ts': 'catálogo de ubigeo: tabla GLOBAL, sin tenantId, de solo lectura',
}

/** Archivos que usan SQL directo (`$queryRaw`, `$executeRaw`...): se saltan TODA la extensión. */
const RAW: Record<string, string> = {
  'src/lib/tenant-prisma.ts': 'solo lo menciona en la documentación del límite',
  'src/app/api/diagnostics/route.ts': 'lee _prisma_migrations y cuenta filas de diagnóstico',
  'src/app/api/diagnostics/perf/route.ts': 'mide latencias con SELECT 1',
  'src/features/seguridad/mfa-service.ts': 'array_remove atómico: consumir un código de recuperación una sola vez',
}

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}

function main() {
  const proj = proyecto()
  const usanBase: string[] = []
  const usanRaw: string[] = []
  const clientesQueLoImportan: string[] = []

  for (const f of ficheros(join(RAIZ, 'src'), (p) => /\.(ts|tsx)$/.test(p))) {
    const r = rel(f)
    if (r.startsWith('src/generated/') || r === 'src/lib/prisma.ts') continue
    const sf = proj.addSourceFileAtPath(f)

    const importaBase = sf.getImportDeclarations().some((i) => {
      const m = i.getModuleSpecifierValue()
      return (m === '@/lib/prisma' || m === './prisma' || m === '../lib/prisma')
        && i.getNamedImports().some((n) => n.getName() === 'prisma')
    })
    if (importaBase) {
      usanBase.push(r)
      if (/^\s*['"]use client['"]/.test(sf.getFullText())) clientesQueLoImportan.push(r)
    }

    const raw = sf.getDescendantsOfKind(SyntaxKind.Identifier).some((i) =>
      ['$queryRaw', '$executeRaw', '$queryRawUnsafe', '$executeRawUnsafe'].includes(i.getText()))
      || /\$(queryRaw|executeRaw)(Unsafe)?\b/.test(sf.getFullText())
    if (raw) usanRaw.push(r)
  }

  console.log('\n1) Cliente Prisma base')
  const sinPermiso = usanBase.filter((r) => !(r in BASE))
  check('>>> todo archivo que usa `prisma` base está en la lista con su motivo', sinPermiso.length === 0,
    sinPermiso.length ? `NO listados: ${sinPermiso.join(', ')}` : `${usanBase.length} archivos`)
  const obsoletos = Object.keys(BASE).filter((r) => !usanBase.includes(r))
  check('la lista no está podrida: todo lo listado lo usa de verdad', obsoletos.length === 0, obsoletos.join(', '))
  check('cada entrada tiene un motivo escrito', Object.values(BASE).every((m) => m.trim().length >= 10))
  check('>>> ningún componente de CLIENTE ("use client") importa el cliente base', clientesQueLoImportan.length === 0, clientesQueLoImportan.join(', '))

  console.log('\n2) SQL directo')
  const rawSinPermiso = usanRaw.filter((r) => !(r in RAW))
  check('>>> todo archivo con $queryRaw/$executeRaw está en la lista con su motivo', rawSinPermiso.length === 0,
    rawSinPermiso.length ? `NO listados: ${rawSinPermiso.join(', ')}` : `${usanRaw.length} archivos`)
  const rawObsoletos = Object.keys(RAW).filter((r) => !usanRaw.includes(r))
  check('la lista de SQL directo no está podrida', rawObsoletos.length === 0, rawObsoletos.join(', '))
  check('todo SQL directo está además en la lista del cliente base (necesita el cliente base)', usanRaw.every((r) => r in BASE))

  console.log('\n3) Zonas que NUNCA deben tocar el cliente base')
  const prohibidos = usanBase.filter((r) =>
    /^src\/features\/(pos|inventory|invoicing|branches|guias|dashboard|printing)\//.test(r))
  check('>>> el POS, inventario, facturación, sucursales, guías, panel e impresión usan SOLO el cliente aislado', prohibidos.length === 0, prohibidos.join(', '))

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  process.exit(fail === 0 ? 0 : 1)
}

main()
