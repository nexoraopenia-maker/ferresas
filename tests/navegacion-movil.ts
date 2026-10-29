import './guard'
import { correr } from './teardown'
import { readFileSync } from 'node:fs'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { PathnameContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import { NavLinks } from '../src/features/shell/components/NavLinks'
import { NAV_ITEMS, visibleItems } from '../src/features/shell/nav-items'
import { permisosDe } from '../src/lib/puede'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * La barra de navegación del móvil. Con 15 o más enlaces (el dueño) no caben todos a la vez: la barra se desliza en horizontal, cada
 * enlace tiene un ancho mínimo legible, el activo está marcado y «Salir» no se desplaza. Se renderiza con los permisos reales de cada
 * rol; lo que no se puede comprobar aquí (cómo se ve en un teléfono) se dice en el reporte.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const noop = () => undefined
const stub = { push: noop, replace: noop, refresh: noop, back: noop, forward: noop, prefetch: noop }
const ctxDe = (role: Role): TenantContext => ({ tenantId: 't', userId: 'u', role, access: 'FULL', branchId: 'b', permisosExtra: [] })
const render = (el: ReactElement, ruta: string) =>
  renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: stub as never }, createElement(PathnameContext.Provider, { value: ruta }, el)))
const barra = (rol: Role, ruta = '/panel', variant: 'bottom' | 'sidebar' = 'bottom') =>
  render(createElement(NavLinks, { variant, permisos: [...permisosDe(ctxDe(rol))] }), ruta)
const enlaces = (h: string) => h.match(/<a [^>]*>/g) ?? []

async function main() {
  console.log('\nA) Los enlaces de la barra inferior')
  const roles: Role[] = ['OWNER', 'ADMIN', 'CAJERO', 'VENDEDOR', 'ALMACENERO', 'CONTADOR']
  check('>>> cada rol ve en la barra EXACTAMENTE los enlaces que le tocan (los mismos que el menú de escritorio)', roles.every((r) => enlaces(barra(r)).length === visibleItems([...permisosDe(ctxDe(r))]).length))
  const dueno = enlaces(barra('OWNER'))
  check('>>> el dueño ve 27 enlaces (más de los que caben en un móvil: por eso la barra se desliza)', dueno.length === NAV_ITEMS.length && dueno.length === 27, String(dueno.length))
  check('>>> TODO enlace tiene ancho mínimo legible (4.25rem) y NO se encoge: nunca se aprieta hasta ser ilegible', roles.every((r) => enlaces(barra(r)).every((a) => a.includes('min-w-[4.25rem]') && a.includes('shrink-0'))) && !roles.some((r) => enlaces(barra(r)).some((a) => a.includes('min-w-0'))))
  check('con pocos enlaces siguen repartiéndose el ancho (flex-1): un rol de pocos enlaces no queda arrinconado', enlaces(barra('CONTADOR')).every((a) => a.includes('flex-1')))
  check('>>> a 390 px el dueño NO cabe sin deslizar (27 enlaces × 4.25rem = 1836 px): por eso la barra se desliza; hasta el contador (8 enlaces, 544 px) pasa del ancho de un móvil pequeño', dueno.length * 68 > 390 && enlaces(barra('CONTADOR')).length * 68 > 390, `contador: ${enlaces(barra('CONTADOR')).length} enlaces`)

  console.log('\nB) El enlace activo')
  const hC = barra('OWNER', '/clientes/abc123')
  const activos = enlaces(hC).filter((a) => a.includes('aria-current="page"'))
  check('>>> en /clientes/abc123 está marcado «Clientes» y SOLO ese (coincidencia por prefijo, no se encienden dos)', activos.length === 1 && activos[0]!.includes('href="/clientes"') && activos[0]!.includes('data-nav-activo="true"'))
  check('en /cobranza se marca «Por cobrar»; en /panel, «Panel»; en una ruta sin enlace, ninguno', enlaces(barra('OWNER', '/cobranza')).filter((a) => a.includes('aria-current')).map((a) => /href="([^"]+)"/.exec(a)![1]).join() === '/cobranza' && enlaces(barra('OWNER', '/panel')).filter((a) => a.includes('aria-current')).length === 1 && enlaces(barra('OWNER', '/no-existe')).filter((a) => a.includes('aria-current')).length === 0)
  check('el activo se resalta distinto (fondo propio); los demás, en gris', activos[0]!.length > 0 && hC.includes('bg-industrial-50') && hC.includes('text-ink-muted'))

  console.log('\nC) El escritorio no cambia')
  const hS = barra('OWNER', '/panel', 'sidebar')
  check('>>> la columna lateral de escritorio sigue igual: etiqueta larga, sin ancho mínimo de la barra móvil', hS.includes('h-touch-lg') && !hS.includes('min-w-[4.25rem]') && enlaces(hS).length === NAV_ITEMS.length)

  console.log('\nD) El contenedor (estructura)')
  const layout = readFileSync('src/app/(dashboard)/layout.tsx', 'utf8')
  // Hay DOS barras con esa etiqueta (la lateral de escritorio y la inferior de móvil): la de móvil es la última.
  const ini = layout.lastIndexOf('aria-label="Navegación principal"')
  const nav = layout.slice(ini - 60, layout.indexOf('</nav>', ini))
  check('>>> los enlaces van dentro de un contenedor que se desliza en horizontal (overflow-x-auto), con la barra de desplazamiento oculta y sin arrastrar la página (overscroll-x-contain)', nav.includes('data-nav="desliza"') && nav.includes('overflow-x-auto') && nav.includes('overscroll-x-contain') && nav.includes('[scrollbar-width:none]') && nav.includes('[&::-webkit-scrollbar]:hidden'))
  check('>>> «Salir» queda FUERA del contenedor que se desliza y no se encoge (siempre a mano)', nav.indexOf('</div>') < nav.indexOf('<form action={logoutAction}') && /<form action=\{logoutAction\} className="flex w-\[4\.25rem\] shrink-0">/.test(nav))
  check('la barra sigue siendo solo de móvil (lg:hidden) y pegada abajo (sticky)', nav.includes('lg:hidden') && nav.includes('sticky bottom-0'))
  const links = readFileSync('src/features/shell/components/NavLinks.tsx', 'utf8')
  check('>>> al cambiar de sección se trae el enlace ACTIVO a la vista (scrollIntoView centrado, sin mover la página en vertical), solo en la barra móvil', /scrollIntoView\(\{ inline: 'center', block: 'nearest' \}\)/.test(links) && links.includes("variant === 'bottom'") && links.includes('ref={activo ? activoRef : undefined}'))

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}
correr(main)
