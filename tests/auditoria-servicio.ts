import './guard'
import { correr } from './teardown'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { parametrosAuditoriaSchema, type ParametrosAuditoria } from '../src/features/auditoria/schemas'
import { listarAuditoria, personasParaFiltro, type FilaAuditoria } from '../src/features/auditoria/service'
import { PERMISOS_FUERA_DEL_PIN, permisosDenegadosAlOperador } from '../src/features/seguridad/pin-reglas'
import { alcanzable, esOpcional, permisosDeRol, PERMISOS } from '../src/lib/permisos'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * F5.5 · El registro de auditoría contra la base. Lo que más importa: SOLO dueño y administrador lo ven (nadie más, ni con permisos extra);
 * los secretos no salen; la paginación no pierde ni repite filas aunque compartan instante; cada negocio ve lo suyo y nunca las acciones
 * globales sin negocio; el periodo respeta la hora del negocio.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const ruc = () => completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)
const AHORA = new Date('2026-10-27T03:00:00Z')   // lunes 26/10/2026 22:00 en Lima
const P = (o: Record<string, unknown> = {}): ParametrosAuditoria => parametrosAuditoriaSchema.parse({ p: 'RANGO', desde: '2026-10-20', hasta: '2026-10-26', ...o })

async function negocio(tag: string) {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({ data: { slug: `rp-${tag}-${randomUUID().slice(0, 6)}`, name: `Auditoria ${tag}`, taxId: ruc(), planId: plan.id } })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_rp' } })
  const b1 = await crearSucursalConAlmacen(t.id)
  const b2 = await crearSucursalConAlmacen(t.id, { almacenCode: 'ALM2', seriesNumber: 2, branchCode: 'B2', establishmentCode: '0002' })
  const u: Record<string, { id: string; ctx: TenantContext }> = {}
  for (const [nombre, role] of [['owner', 'OWNER'], ['admin', 'ADMIN'], ['contador', 'CONTADOR'], ['cajero', 'CAJERO'], ['vendedor', 'VENDEDOR'], ['almacenero', 'ALMACENERO']] as [string, Role][]) {
    const x = await prisma.user.create({ data: { tenantId: t.id, email: `${nombre}-${randomUUID()}@x.com`.toLowerCase(), name: nombre === 'owner' ? 'Dueña Rosa' : nombre, role } })
    await asignarSucursal(t.id, x.id, b1.branch.id)
    u[nombre] = { id: x.id, ctx: { tenantId: t.id, userId: x.id, role, access: 'FULL', branchId: b1.branch.id, branchIds: [b1.branch.id, b2.branch.id], permisosExtra: [] } }
  }
  return { t, b1, b2, u, db: (c: TenantContext) => getTenantPrisma(c) }
}
type N = Awaited<ReturnType<typeof negocio>>
const reg = (n: N, o: { action: string; en: string; actor?: string | null; entityType?: string; entityId?: string; before?: unknown; after?: unknown; tenant?: string | null; impersonationId?: string; email?: string; reason?: string; id?: string }) =>
  prisma.auditLog.create({ data: {
    ...(o.id ? { id: o.id } : {}), tenantId: o.tenant === undefined ? n.t.id : o.tenant, actorId: o.actor === undefined ? n.u.owner!.id : o.actor, actorRole: 'OWNER', actorEmail: o.email ?? null, action: o.action,
    entityType: o.entityType ?? null, entityId: o.entityId ?? null, before: (o.before ?? undefined) as never, after: (o.after ?? undefined) as never, impersonationId: o.impersonationId ?? null, reason: o.reason ?? null, createdAt: new Date(o.en),
  } })

async function main() {
  try { return await cuerpo() } catch (e) {
    check('>>> la prueba termina sin excepciones inesperadas', false, e instanceof Error ? e.message.slice(0, 200) : String(e))
    console.log(`\n✖ ${pass} pasaron, ${fail} fallaron`)
    return fail
  }
}

async function cuerpo() {
  console.log('\nA) El escenario')
  const n = await negocio('uno'), o = await negocio('dos')
  const { u } = n
  const owner = u.owner!.ctx
  // 120 ventas con descuento en SOLO tres instantes: la paginación tiene que desempatar por id.
  const instantes = ['2026-10-22T15:00:00.000Z', '2026-10-23T15:00:00.000Z', '2026-10-24T15:00:00.000Z']
  for (let i = 0; i < 120; i++) await reg(n, { action: 'sale.discount', en: instantes[i % 3]!, entityType: 'Sale', entityId: `venta-${i}`, actor: u.cajero!.id })
  await reg(n, { action: 'credito.abono', en: '2026-10-25T15:00:00.000Z', entityType: 'Cliente', entityId: 'cli-1', after: { monto: 40 } })
  await reg(n, { action: 'sunat.credenciales_guardadas', en: '2026-10-25T16:00:00.000Z', entityType: 'Tenant', entityId: 'cfg', before: null, after: { url: 'https://api.pse.pe', token: 'TOKEN-SECRETO-1', anidado: { claveSol: 'CLAVE-SOL-2', passwordHash: 'HASH-3', ok: 'visible' } } })
  await reg(n, { action: 'algo.nuevo', en: '2026-10-25T17:00:00.000Z', entityId: 'x-1' })
  await reg(n, { action: 'impersonation.start', en: '2026-10-25T18:00:00.000Z', actor: null, email: 'soporte@saas.pe', reason: 'ticket 123' })
  await reg(n, { action: 'sale.below_stock', en: '2026-10-25T19:00:00.000Z', impersonationId: 'imp-1', entityType: 'Sale', entityId: 'v-soporte' })
  await reg(n, { action: 'cliente.baja', en: '2026-10-21T15:00:00.000Z', actor: null, email: 'exempleado@x.com', entityType: 'Cliente', entityId: 'cli-9' })
  // Fuera del periodo por UN SEGUNDO (Lima: 19/10 23:59:59 y 27/10 00:00:00) y de otro negocio / sin negocio
  await reg(n, { action: 'cash.open', en: '2026-10-20T04:59:59.000Z', entityId: 'antes' })
  await reg(n, { action: 'cash.open', en: '2026-10-27T05:00:00.000Z', entityId: 'despues' })
  await reg(o, { action: 'sale.discount', en: '2026-10-22T15:00:00.000Z', entityId: 'ajena', actor: o.u.owner!.id })
  await reg(n, { action: 'tenant.suspend', en: '2026-10-22T15:00:00.000Z', tenant: null, actor: null, entityId: 'global' })
  const total = 120 + 6
  check('(preparación) registros creados', (await prisma.auditLog.count({ where: { tenantId: n.t.id } })) === total + 2)

  console.log('\nB) Permiso: solo dueño y administrador')
  const probar = async (c: TenantContext) => [await code(listarAuditoria(n.db(c), c, P(), AHORA)), await code(personasParaFiltro(n.db(c), c))]
  for (const r of ['owner', 'admin']) check(`>>> ${r} puede verlo`, (await probar(u[r]!.ctx)).every((x) => x === null))
  for (const r of ['contador', 'cajero', 'vendedor', 'almacenero']) check(`>>> ${r} NO puede (FORBIDDEN_ROLE)`, (await probar(u[r]!.ctx)).every((x) => x === 'FORBIDDEN_ROLE'))
  check('>>> `auditoria.ver` no es opcional de NINGÚN rol ni lo concede la matriz a otro que dueño y administrador (los permisos extra que fabrica la aplicación son opcionales)', (['OWNER', 'ADMIN', 'CONTADOR', 'CAJERO', 'VENDEDOR', 'ALMACENERO', 'SUPERADMIN'] as Role[]).every((r) => !esOpcional(r, 'auditoria.ver') && (permisosDeRol(r).has('auditoria.ver') === (r === 'OWNER' || r === 'ADMIN'))) && (['CONTADOR', 'CAJERO', 'VENDEDOR', 'ALMACENERO'] as Role[]).every((r) => !alcanzable(r, 'auditoria.ver')))
  check('>>> el PIN de un operador no abre la auditoría: aunque la sesión sea del dueño, el permiso queda vedado', PERMISOS_FUERA_DEL_PIN.includes('auditoria.ver') && permisosDenegadosAlOperador(new Set(PERMISOS)).includes('auditoria.ver'))
  check('`reportes.ver` o `usuarios.gestionar` por sí solos no bastan', (await probar({ ...u.contador!.ctx, permisosExtra: ['reportes.ver'] })).every((x) => x === 'FORBIDDEN_ROLE'))
  check('>>> un administrador al que se le deniega `auditoria.ver` pierde la pantalla', (await probar({ ...u.admin!.ctx, permisosDenegados: ['auditoria.ver'] })).every((x) => x === 'FORBIDDEN_ROLE'))

  console.log('\nC) Periodo, orden y paginación')
  const todas: FilaAuditoria[] = []
  let cursor: string | undefined
  let paginas = 0
  for (;;) {
    const r = await listarAuditoria(n.db(owner), owner, P({ cursor }), AHORA)
    todas.push(...r.filas); paginas++
    if (r.filas.length > 50) break
    if (!r.siguiente || paginas >= 6) break
    cursor = r.siguiente
  }
  check(`>>> recorre TODO sin perder ni repetir: ${total} registros en ${paginas} páginas de hasta 50`, todas.length === total && new Set(todas.map((f) => f.id)).size === total && paginas === 3, `${todas.length}/${new Set(todas.map((f) => f.id)).size}/${paginas}`)
  check('>>> orden: del más reciente al más antiguo, y con el mismo instante por id descendente', todas.every((f, i) => i === 0 || f.cuando < todas[i - 1]!.cuando || (f.cuando === todas[i - 1]!.cuando && f.id < todas[i - 1]!.id)))
  check('>>> la frontera es la medianoche de Lima: los registros a un segundo de cada borde NO entran', !todas.some((f) => f.entidad?.includes('antes') || f.entidad?.includes('despues')) && (await prisma.auditLog.count({ where: { tenantId: n.t.id, entityId: { in: ['antes', 'despues'] } } })) === 2)
  const primera = await listarAuditoria(n.db(owner), owner, P(), AHORA)
  check('la primera página trae 50 y avisa que hay más; la última no', primera.filas.length === 50 && primera.siguiente !== null && todas.length - 100 === 26)
  check('el periodo y la zona se informan', primera.textoPeriodo === '20/10/2026 – 26/10/2026' && primera.zona === 'America/Lima')
  check('>>> un rango imposible → INVALID_DOCUMENT (no un 500)', (await code(listarAuditoria(n.db(owner), owner, P({ desde: '2026-10-26', hasta: '2026-10-20' }), AHORA))) === 'INVALID_DOCUMENT')

  console.log('\nD) Aislamiento')
  check('>>> el otro negocio no aparece ni las acciones globales sin negocio', !todas.some((f) => f.entidad?.includes('ajena') || f.entidad?.includes('global')) && !todas.some((f) => f.accion === 'tenant.suspend'))
  const deO = await listarAuditoria(o.db(o.u.owner!.ctx), o.u.owner!.ctx, P(), AHORA)
  check('el otro negocio ve solo lo suyo', deO.filas.length === 1 && deO.filas[0]!.entidad?.includes('ajena') === true)
  const personas = await personasParaFiltro(n.db(owner), owner)
  check('>>> el filtro «Quién» lista solo a las personas del negocio', personas.length === 6 && personas.every((p) => Object.values(u).some((x) => x.id === p.id)))
  const adminUna: TenantContext = { ...u.admin!.ctx, branchIds: [n.b1.branch.id] }
  check('alcance documentado: el registro no tiene sucursal, un administrador de una sola sucursal ve el del negocio', (await listarAuditoria(n.db(adminUna), adminUna, P(), AHORA)).filas.length === 50)

  console.log('\nE) Filtros')
  const cat = await listarAuditoria(n.db(owner), owner, P({ categoria: 'Crédito y cobranza' }), AHORA)
  check('por categoría: solo los créditos', cat.filas.length === 1 && cat.filas[0]!.accion === 'credito.abono' && cat.filas[0]!.etiqueta === 'Abono de un cliente')
  const otros = await listarAuditoria(n.db(owner), owner, P({ categoria: 'Otros' }), AHORA)
  check('>>> «Otros» trae lo que no está en el catálogo (no se pierde)', otros.filas.length === 1 && otros.filas[0]!.accion === 'algo.nuevo' && otros.filas[0]!.categoria === 'Otros' && otros.filas[0]!.etiqueta === 'algo.nuevo')
  const porActor = await listarAuditoria(n.db(owner), owner, P({ actor: u.owner!.id }), AHORA)
  check('por quién: solo lo del dueño (los descuentos del cajero fuera)', porActor.filas.length > 0 && porActor.filas.length < 50 && porActor.filas.every((f) => f.actor === 'Dueña Rosa'))
  const porEnt = await listarAuditoria(n.db(owner), owner, P({ entidad: 'venta-7' }), AHORA)
  check('por documento: exactamente ese', porEnt.filas.length === 1 && porEnt.filas[0]!.entidad === 'Sale venta-7')
  const mixto = await listarAuditoria(n.db(owner), owner, P({ categoria: 'Ventas y caja', actor: u.cajero!.id, desde: '2026-10-23', hasta: '2026-10-23' }), AHORA)
  check('>>> los filtros se combinan (categoría + quién + un día): 40 descuentos de ese día', mixto.filas.length === 40 && mixto.siguiente === null)
  check('un filtro sin resultados da lista vacía', (await listarAuditoria(n.db(owner), owner, P({ entidad: 'no-existe' }), AHORA)).filas.length === 0)

  console.log('\nF) Lo que se muestra de cada registro')
  const pse = todas.find((f) => f.accion === 'sunat.credenciales_guardadas')!
  check('>>> los secretos NO salen: token, clave SOL y hash tapados aun anidados; lo demás sí', !JSON.stringify(pse).includes('SECRETO') && !JSON.stringify(pse).includes('CLAVE-SOL') && !JSON.stringify(pse).includes('HASH-3') && pse.despues!.texto.includes('visible') && pse.despues!.texto.includes('https://api.pse.pe') && pse.despues!.texto.includes('«oculto»'))
  check('sin antes/después guardado → null (la pantalla dice «no guardó detalle»)', pse.antes === null && todas.find((f) => f.accion === 'algo.nuevo')!.despues === null)
  const sop = todas.find((f) => f.accion === 'sale.below_stock')!
  check('>>> lo hecho durante una sesión de soporte se marca', sop.soporte && !pse.soporte)
  const start = todas.find((f) => f.accion === 'impersonation.start')!
  check('actor sin usuario: se muestra el correo congelado; el motivo se conserva; etiqueta en español', start.actor === 'soporte@saas.pe' && start.motivo === 'ticket 123' && start.etiqueta === 'Soporte entró a tu cuenta' && todas.find((f) => f.accion === 'cliente.baja')!.actor === 'exempleado@x.com')
  check('el rol y la entidad se muestran', pse.rol === 'OWNER' && pse.entidad === 'Tenant cfg' && pse.actor === 'Dueña Rosa')

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
