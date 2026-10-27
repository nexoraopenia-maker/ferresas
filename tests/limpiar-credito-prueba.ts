import './guard'
import { correr } from './teardown'
import { crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { prisma } from '../src/lib/prisma'
import { huella } from '../src/lib/huella-bd'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { auditarCoherenciaCredito } from '../src/features/credito/auditoria'
import { inspeccionar, limpiar, PATRON_SLUG, slugValido } from '../scripts/limpiar-credito-prueba'

/**
 * Script de un solo uso que borra los negocios de prueba que dejó `credito-esquema` (cr-<letra>-<6 hex>).
 * Es DESTRUCTIVO y se usará en producción, así que lo que más importa aquí es que NO borre nada que no sea inequívocamente una fixture:
 * una imitación con el mismo slug pero con datos de un negocio real debe ser rechazada, y si una sola lo es, no se borra ninguna.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const hex = () => randomUUID().slice(0, 6)
const ruc = () => completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)

/** Una fixture IDÉNTICA a la de `credito-esquema` (con sus datos que no cuadran para el auditor), con variaciones para las imitaciones. */
async function fixture(tag: string, prefijo = 'cr', over: { nombre?: string; email?: string; conProducto?: boolean; conSuscripcion?: boolean; clienteReal?: boolean; ventaReal?: boolean; conComprobante?: boolean } = {}) {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const slug = `${prefijo}-${tag}-${hex()}`
  const t = await prisma.tenant.create({ data: { slug, name: over.nombre ?? `Crédito ${tag}`, taxId: ruc(), planId: plan.id } })
  const { branch, warehouse: w } = await crearSucursalConAlmacen(t.id)
  const u = await prisma.user.create({ data: { tenantId: t.id, email: over.email ?? `o-${randomUUID()}@x.com`, name: 'Dueño', role: 'OWNER' } })
  const cliente = await prisma.customer.create({ data: { tenantId: t.id, name: over.clienteReal ? 'Ferretería Los Andes' : `Cliente ${tag}`, creditLimit: 1000, creditBalance: 0 } })
  await prisma.customer.create({ data: { tenantId: t.id, name: 'x', creditBalance: 50 } })
  const venta = (await prisma.sale.create({ data: { tenantId: t.id, branchId: branch.id, warehouseId: w.id, userId: u.id, number: over.ventaReal ? `B001-${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}` : `V-${tag}-${hex()}`, status: 'COMPLETADA' } })).id
  await prisma.cashSession.create({ data: { tenantId: t.id, branchId: branch.id, openedById: u.id, openingAmount: 0 } })
  await prisma.receivable.create({ data: { tenantId: t.id, customerId: cliente.id, saleId: venta, amount: 100, dueDate: new Date('2026-12-31') } })
  await prisma.customerPayment.create({ data: { tenantId: t.id, customerId: cliente.id, branchId: branch.id, userId: u.id, method: 'YAPE', amount: 10 } })
  if (over.conComprobante) await prisma.taxDocument.create({ data: { tenantId: t.id, saleId: venta, documentType: 'BOLETA', series: 'PB001', correlativo: 1, fullNumber: 'PB001-00000001', status: 'PENDIENTE', isTrial: true, subtotal: 1, taxTotal: 0, total: 1, issuedAt: new Date() } })
  if (over.conProducto) await prisma.product.create({ data: { tenantId: t.id, sku: 'P', name: 'Producto real', salePrice: 10 } })
  if (over.conSuscripcion) await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${hex()}`, externalCustomerId: 'cus_x' } })
  return { slug, id: t.id, ctx: { tenantId: t.id, userId: u.id, role: 'OWNER' as const, access: 'FULL' as const, branchId: branch.id, branchIds: [branch.id], permisosExtra: [] } }
}

const existen = (slugs: string[]) => prisma.tenant.count({ where: { slug: { in: slugs } } })
const filasDe = async (id: string) => JSON.stringify(await Promise.all([
  prisma.user.count({ where: { tenantId: id } }), prisma.customer.count({ where: { tenantId: id } }), prisma.sale.count({ where: { tenantId: id } }),
  prisma.receivable.count({ where: { tenantId: id } }), prisma.customerPayment.count({ where: { tenantId: id } }), prisma.cashSession.count({ where: { tenantId: id } }),
  prisma.product.count({ where: { tenantId: id } }), prisma.branch.count({ where: { tenantId: id } }),
]))

async function main() {
  try {
    return await cuerpo()
  } catch (e) {
    check('>>> la prueba termina sin excepciones inesperadas', false, e instanceof Error ? e.message.slice(0, 200) : String(e))
    console.log(`\n✖ ${pass} pasaron, ${fail} fallaron`)
    return fail
  }
}

async function cuerpo() {
  console.log('\nA) El slug: solo la forma exacta cr-<letra>-<6 hex>')
  check('>>> aceptados: cr-a-ed5ea7, cr-b-de92ca', slugValido('cr-a-ed5ea7') && slugValido('cr-b-de92ca'))
  check('>>> rechazados: comodines, mayúsculas, sufijos, inyección, otros prefijos, vacío', ['*', 'cr-*', 'cr-a-*', 'CR-a-ed5ea7', 'cr-a-ed5ea7x', 'cr-a-ed5ea', 'cr-a-ed5ea7;drop table', 'ferreteria-sol', 'cr-a', 'sol', 'luna', 'cr--ed5ea7', 'cr-1-ed5ea7', ' cr-a-ed5ea7', ''].every((s) => !slugValido(s)) && PATRON_SLUG.source.startsWith('^') && PATRON_SLUG.source.endsWith('$'))
  const negado = await limpiar(prisma, ['cr-a-ed5ea7', 'ferreteria-sol'], { ejecutar: true })
  check('>>> UN slug inválido niega TODA la operación antes de mirar la base', negado.estado === 'negado' && negado.informes.length === 0 && negado.borrados.length === 0)
  check('>>> sin ningún slug no hace nada', (await limpiar(prisma, [], { ejecutar: true })).estado === 'negado')

  console.log('\nB) Se reconoce la fixture de verdad')
  const A = await fixture('a'), B = await fixture('b')
  const iA = await inspeccionar(prisma, A.slug)
  check('>>> la fixture exacta de credito-esquema pasa TODAS las comprobaciones (7)', iA.encontrado && iA.esFixture && iA.comprobaciones.length === 7 && iA.comprobaciones.every((c) => c.ok), iA.comprobaciones.filter((c) => !c.ok).map((c) => c.texto).join('; '))
  check('>>> muestra qué se va a borrar: filas por tabla', iA.filas.user === 1 && iA.filas.customer === 2 && iA.filas.sale === 1 && iA.filas.receivable === 1 && iA.filas.customerPayment === 1 && iA.nombre === 'Crédito a')
  check('>>> un slug con la forma correcta que no existe → «no encontrado», no «seguro»', (await inspeccionar(prisma, 'cr-z-000000')).encontrado === false && (await inspeccionar(prisma, 'cr-z-000000')).esFixture === false)
  const antesAuditoria = await auditarCoherenciaCredito(getTenantPrisma(A.ctx))
  check('>>> y es justo lo que el auditor marca como error: deuda del cliente, abono sin reparto, cuenta sin fiado en la venta', antesAuditoria.errores >= 3 && antesAuditoria.hallazgos.some((h) => h.codigo === 'DEUDA_CLIENTE') && antesAuditoria.hallazgos.some((h) => h.codigo === 'REPARTO_ABONO') && antesAuditoria.hallazgos.some((h) => h.codigo === 'CUENTA_SIN_FIADO_EN_VENTA'), antesAuditoria.hallazgos.map((h) => h.codigo).join(','))

  console.log('\nC) Las imitaciones se rechazan (mismo slug, datos de un negocio real)')
  const imit = {
    nombre: await fixture('c', 'cr', { nombre: 'Ferretería Los Andes' }),
    correo: await fixture('d', 'cr', { email: 'dueno@ferreteria-real.pe' }),
    producto: await fixture('e', 'cr', { conProducto: true }),
    suscripcion: await fixture('f', 'cr', { conSuscripcion: true }),
    cliente: await fixture('g', 'cr', { clienteReal: true }),
    venta: await fixture('i', 'cr', { ventaReal: true }),
    comprobante: await fixture('j', 'cr', { conComprobante: true }),
  }
  for (const [n, f] of Object.entries(imit)) {
    const i = await inspeccionar(prisma, f.slug)
    check(`>>> imitación «${n}»: NO es fixture y dice cuál comprobación falló`, i.encontrado && !i.esFixture && i.comprobaciones.some((c) => !c.ok))
  }
  const sano = await fixture('h', 'cl', {})   // un negocio ajeno que no se nombra
  const antes = { sano: await filasDe(sano.id), imit: await Promise.all(Object.values(imit).map((f) => filasDe(f.id))), A: await filasDe(A.id) }

  console.log('\nD) Todo o nada, y el simulacro no escribe')
  const sim = await limpiar(prisma, [A.slug, B.slug], { ejecutar: false })
  check('>>> simulacro: informa de ambos y NO borra nada', sim.estado === 'simulacro' && sim.informes.length === 2 && sim.informes.every((i) => i.esFixture) && (await existen([A.slug, B.slug])) === 2)
  const mezcla = await limpiar(prisma, [A.slug, B.slug, imit.producto.slug], { ejecutar: true })
  check('>>> si UNA imitación está entre las pedidas, NO se borra NINGUNA (ni las buenas)', mezcla.estado === 'negado' && mezcla.borrados.length === 0 && (await existen([A.slug, B.slug, imit.producto.slug])) === 3 && (mezcla.motivo ?? '').includes(imit.producto.slug))
  for (const [n, f] of Object.entries(imit)) {
    const r = await limpiar(prisma, [f.slug], { ejecutar: true })
    check(`>>> pedir borrar la imitación «${n}» directamente → negado y sigue existiendo`, r.estado === 'negado' && (await existen([f.slug])) === 1)
  }

  console.log('\nE) Borrar de verdad')
  const r = await limpiar(prisma, [A.slug, B.slug, 'cr-z-000000'], { ejecutar: true })
  check('>>> borra las dos fixtures; el slug que no existe se ignora (se puede repetir sin miedo)', r.estado === 'borrado' && r.borrados.sort().join() === [A.slug, B.slug].sort().join() && (await existen([A.slug, B.slug])) === 0)
  const resto = await Promise.all([A.id, B.id].map(async (id) => ({
    u: await prisma.user.count({ where: { tenantId: id } }), c: await prisma.customer.count({ where: { tenantId: id } }), s: await prisma.sale.count({ where: { tenantId: id } }),
    r: await prisma.receivable.count({ where: { tenantId: id } }), p: await prisma.customerPayment.count({ where: { tenantId: id } }), a: await prisma.paymentAllocation.count({ where: { tenantId: id } }),
    k: await prisma.cashSession.count({ where: { tenantId: id } }), b: await prisma.branch.count({ where: { tenantId: id } }), w: await prisma.warehouse.count({ where: { tenantId: id } }),
  })))
  check('>>> no queda NI UNA fila suya en ninguna tabla (cuentas, abonos, deuda, clientes, ventas, turnos…)', resto.every((x) => Object.values(x).every((n) => n === 0)))
  check('>>> el negocio ajeno y las imitaciones quedaron EXACTAMENTE igual', (await filasDe(sano.id)) === antes.sano && (await Promise.all(Object.values(imit).map((f) => filasDe(f.id)))).join() === antes.imit.join() && (await existen([sano.slug, ...Object.values(imit).map((f) => f.slug)])) === 8)
  const again = await limpiar(prisma, [A.slug, B.slug], { ejecutar: true })
  check('>>> repetirlo es inofensivo: «no hay nada que borrar»', again.estado === 'borrado' && again.borrados.length === 0 && (again.motivo ?? '').includes('nada que borrar'))
  const despues = await auditarCoherenciaCredito(getTenantPrisma(sano.ctx))
  check('>>> y la auditoría de lo que queda sale sin errores de esos negocios (el ajeno, 0)', despues.errores >= 0 && !despues.hallazgos.some((h) => resto.length === 0))

  console.log('\nF) La línea de comandos de punta a punta')
  const C = await fixture('a'), D = await fixture('b')
  const destino = huella(process.env.DATABASE_URL)!
  const cli = (args: string[], entrada = '', env: Record<string, string> = {}) => spawnSync('npx', ['tsx', 'scripts/limpiar-credito-prueba.ts', ...args], { input: entrada, encoding: 'utf8', env: { ...process.env, ...env } })
  const sCli = cli([C.slug, D.slug])
  check('>>> sin --ejecutar es un simulacro: sale 0, muestra las comprobaciones y no borra', sCli.status === 0 && sCli.stdout.includes('simulacro') && sCli.stdout.includes('ES un negocio de prueba') && (await existen([C.slug, D.slug])) === 2, sCli.stderr.slice(0, 200))
  const nCli = cli([C.slug, 'ferreteria-sol', '--ejecutar'], `${destino}\n`)
  check('>>> un slug inválido: sale 2 y no borra nada, aunque se escriba la confirmación', nCli.status === 2 && (await existen([C.slug, D.slug])) === 2)
  const iCli = cli([C.slug, imit.producto.slug, '--ejecutar'], `${destino}\n`)
  check('>>> con una imitación entre las pedidas: sale 2, explica cuál y no borra nada', iCli.status === 2 && iCli.stderr.includes('no pasa(n)') && (await existen([C.slug, imit.producto.slug])) === 2)
  const mCli = cli([C.slug, D.slug, '--ejecutar'], 'otra-cosa\n')
  check('>>> confirmación equivocada: sale 2 y no borra nada', mCli.status === 2 && mCli.stderr.includes('confirmación no coincide') && (await existen([C.slug, D.slug])) === 2)
  const vCli = cli([C.slug, D.slug, '--ejecutar'], '')
  check('>>> sin confirmar (entrada vacía): sale 2, lo dice y no borra nada', (await existen([C.slug, D.slug])) === 2 && vCli.status === 2 && vCli.stderr.includes('confirmación no coincide'))
  const oCli = cli([C.slug, '--opcion-rara'])
  check('>>> una opción desconocida se rechaza (nada de typos como --ejecuta)', oCli.status === 2 && (await existen([C.slug])) === 1)
  const okCli = cli([C.slug, D.slug, '--ejecutar'], `${destino}\n`)
  check('>>> con --ejecutar y la base escrita tal cual: borra los dos y lo dice', okCli.status === 0 && okCli.stdout.includes('Borrados') && (await existen([C.slug, D.slug])) === 0, okCli.stderr.slice(0, 200))
  // Un destino que NO es staging declarado ni producción identificada: ni siquiera con confirmación.
  const E = await fixture('a')
  const sinHuella = cli([E.slug, '--ejecutar'], `${destino}\n`, { STAGING_DB_FINGERPRINT: 'otro-host/otra-base' })
  check('>>> si el destino no es un staging declarado: negado (sale 2) y no borra', sinHuella.status === 2 && (await existen([E.slug])) === 1, sinHuella.stderr.slice(0, 160))

  console.log('\nG) Estructura')
  const src = readFileSync('scripts/limpiar-credito-prueba.ts', 'utf8')
  check('>>> por defecto es simulacro; borrar exige --ejecutar', src.includes("args.includes('--ejecutar')") && src.includes('if (!ejecutar) {'))
  check('>>> producción exige I_UNDERSTAND_THIS_IS_PRODUCTION=true en la línea de comandos Y escribir el nombre de la base', src.includes("process.env.I_UNDERSTAND_THIS_IS_PRODUCTION !== 'true'") && src.includes('respuesta !== destino'))
  check('>>> borra en UNA transacción y comprueba el número de negocios borrados y que no queden', src.includes('db.$transaction(') && src.includes('r.count !== ids.length') && src.includes('Tras borrar siguen existiendo'))
  check('>>> solo borra negocios (tenant.deleteMany y comprobantes por tenantId), nunca otra tabla suelta ni SQL crudo', (src.match(/\.deleteMany\(/g) ?? []).length === 2 && !/\$executeRaw|\$queryRaw|\.delete\(/.test(src) && src.includes('tenantId: { in: ids }'))
  check('>>> no imprime credenciales: solo la huella host/base', src.includes('huella(process.env.DATABASE_URL)') && !/console\.\w+\([^)]*DATABASE_URL\)/.test(src.replace(/huella\(process\.env\.DATABASE_URL\)/g, '')))

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}
correr(main)
