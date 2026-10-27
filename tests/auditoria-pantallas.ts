import { existsSync, readFileSync } from 'node:fs'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { permisosDe } from '../src/lib/puede'
import { ListaAuditoria } from '../src/features/auditoria/components/TablaAuditoria'
import { parametrosAuditoriaSchema } from '../src/features/auditoria/schemas'
import type { FilaAuditoria } from '../src/features/auditoria/service'
import { visibleItems } from '../src/features/shell/nav-items'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * F5.5 · La pantalla del registro de auditoría, renderizada AISLADA. Lo que más importa: solo dueño y administrador la ven (menú, página),
 * los detalles se muestran sin HTML inyectable, el soporte se distingue, y los filtros viajan por la dirección.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const noop = () => undefined
const stub = { push: noop, replace: noop, refresh: noop, back: noop, forward: noop, prefetch: noop }
const html = (el: ReactElement) => renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: stub as never }, el))
const ctxDe = (r: Role): TenantContext => ({ tenantId: 't', userId: 'u', role: r, access: 'FULL', branchId: 'b', permisosExtra: [] })
const P = parametrosAuditoriaSchema.parse({})
const fila = (o: Partial<FilaAuditoria> = {}): FilaAuditoria => ({
  id: 'r1', cuando: '2026-10-25T15:00:00.000Z', accion: 'credito.abono', etiqueta: 'Abono de un cliente', categoria: 'Crédito y cobranza', actor: 'Rosa', rol: 'OWNER', entidad: 'Cliente cli-1',
  motivo: null, antes: null, despues: { texto: '{\n  "monto": 40\n}', truncado: false }, ip: '10.0.0.1', soporte: false, ...o,
})

console.log('\nA) La lista')
const h = html(createElement(ListaAuditoria, { filas: [fila(), fila({ id: 'r2', soporte: true, accion: 'sale.below_stock', etiqueta: 'Venta con stock insuficiente', antes: { texto: 'x', truncado: true }, motivo: 'ticket 9', despues: null })], zona: 'America/Lima', params: P, siguiente: null }))
check('cada registro muestra qué pasó, quién, en qué y cuándo en la hora del negocio (10:00 en Lima)', h.includes('Abono de un cliente') && h.includes('Rosa · owner · Cliente cli-1') && h.includes('25/10/2026, 10:00') || h.includes('25/10/2026 10:00'))
check('>>> el detalle (antes / después, acción técnica, IP) va en un desplegable, no a la vista', h.includes('<details') && h.includes('data-auditoria="json"') && h.includes('credito.abono') && h.includes('10.0.0.1'))
check('>>> lo hecho durante soporte lleva la marca «Soporte»; lo normal no', (h.match(/data-auditoria="soporte"/g) ?? []).length === 1)
check('el motivo y el aviso de recorte se muestran', h.includes('ticket 9') && h.includes('Se recortó por tamaño'))
check('un registro sin detalle lo dice', html(createElement(ListaAuditoria, { filas: [fila({ despues: null })], zona: 'America/Lima', params: P, siguiente: null })).includes('no guardó detalle'))
check('>>> el detalle se escapa: un valor con HTML no se convierte en HTML', (() => { const x = html(createElement(ListaAuditoria, { filas: [fila({ despues: { texto: '"<img src=x onerror=alert(1)>"', truncado: false }, actor: '<b>Evil</b>' })], zona: 'America/Lima', params: P, siguiente: null })); return !x.includes('<img') && !x.includes('<b>Evil') && x.includes('&lt;img') })())
check('sin registros: mensaje de vacío', html(createElement(ListaAuditoria, { filas: [], zona: 'America/Lima', params: P, siguiente: null })).includes('data-reporte="vacio"'))
const mas = html(createElement(ListaAuditoria, { filas: [fila()], zona: 'America/Lima', params: parametrosAuditoriaSchema.parse({ categoria: 'Clientes', p: 'HOY' }), siguiente: '2026-10-25T15:00:00.000Z|abc12345' }))
check('>>> «Ver más antiguos» conserva los filtros y lleva el cursor', mas.includes('data-auditoria="mas"') && mas.includes('/auditoria?p=HOY&amp;categoria=Clientes&amp;cursor=2026-10-25T15%3A00%3A00.000Z%7Cabc12345'))
check('sin siguiente página no hay enlace', !h.includes('data-auditoria="mas"'))

console.log('\nB) Página, menú y permiso')
const D = 'src/app/(dashboard)/auditoria'
const pag = readFileSync(`${D}/page.tsx`, 'utf8'), nav = readFileSync('src/features/shell/nav-items.ts', 'utf8'), serv = readFileSync('src/features/auditoria/service.ts', 'utf8')
check("la página exige sesión y `auditoria.ver` (404 si no); no mira el rol", pag.includes('await requireTenantContext()') && pag.includes("if (!puede(ctx, 'auditoria.ver')) notFound()") && !/ctx\.role/.test(pag))
check('la página lee con el cliente aislado (getTenantPrisma), nunca con el base', pag.includes('getTenantPrisma(ctx)') && !/from '@\/lib\/prisma'/.test(pag + serv))
check('>>> dirección manipulada → última semana con aviso; rango imposible → aviso', pag.includes('parametrosAuditoriaSchema.safeParse(') && pag.includes('Esa dirección tenía filtros que no entiendo') && pag.includes("e.code === 'INVALID_DOCUMENT'") && pag.includes('aviso = e.message'))
check('el servicio exige `auditoria.ver` en la lista y en el filtro de personas, y nada más', (serv.match(/exigirAuditoria\(ctx\)/g) ?? []).length === 2 && serv.includes("exigir(ctx, 'auditoria.ver')") && !/reportes\.ver|usuarios\.gestionar/.test(serv))
check('el servicio no entrega el JSON crudo: antes y después pasan por `mostrarJson`', serv.includes('mostrarJson(r.before)') && serv.includes('mostrarJson(r.after)') && !/antes: r\.before|despues: r\.after/.test(serv))
const enMenu = (r: Role) => visibleItems([...permisosDe(ctxDe(r))]).some((i) => i.href === '/auditoria')
check('>>> el menú muestra Auditoría SOLO a dueño y administrador', enMenu('OWNER') && enMenu('ADMIN') && !enMenu('CONTADOR') && !enMenu('CAJERO') && !enMenu('VENDEDOR') && !enMenu('ALMACENERO'))
check('el enlace del menú usa el mismo permiso', /href: '\/auditoria',[\s\S]*?permisos: \['auditoria\.ver'\]/.test(nav))
check('hay pantalla de carga', existsSync(`${D}/loading.tsx`))
check('el registro es de solo lectura: ninguna escritura en el servicio', !/\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/.test(serv))

console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
process.exit(fail === 0 ? 0 : 1)
