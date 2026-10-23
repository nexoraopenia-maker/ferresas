import './guard'
import { correr } from './teardown'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { SyntaxKind } from 'ts-morph'
import { ficheros, proyecto, RAIZ, rel } from './ast'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { registerSale } from '../src/features/pos/sale-service'
import { registerSaleSchema } from '../src/features/pos/schemas'
import { issueTaxDocument } from '../src/features/invoicing/service'
import { enviarComprobante } from '../src/features/invoicing/envio'
import { faltantesParaEmitir } from '../src/features/invoicing/requisitos-fiscales'
import { obtenerProveedor, type CredencialesProveedor, type ProveedorFacturacion } from '../src/features/invoicing/providers'
import { cambiarFacturacionReal, faltantesParaHabilitar } from '../src/features/superadmin/facturacion-real-service'
import { distritoExiste, exigirDistritoValido } from '../src/features/ubigeo/service'
import { emitirGuia } from '../src/features/guias/service'
import type { EmitirGuiaInput } from '../src/features/guias/schemas'
import type { TenantContext } from '../src/lib/tenant-context'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const msg = (p: Promise<unknown>) => p.then(() => '').catch((e) => String(e.message ?? e))
const cred: CredencialesProveedor = { usuario: 'mock:acepta', clave: 'x', modoPruebas: true }
const manana = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)

async function main() {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const ruc = () => completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)

  // Catálogo de ubigeo: si la tabla está VACÍA se siembra uno mínimo y se retira al final.
  // Si ya hay uno real, se usa tal cual y NO se toca nada que no sea nuestro.
  const version = `test-${randomUUID().slice(0, 8)}`
  const vacio = (await prisma.ubigeo.count()) === 0
  console.log(`\n0) Catálogo de ubigeo en esta base: ${vacio ? 'vacío (se siembra uno mínimo de prueba)' : 'ya cargado (se usa el real)'}`)
  if (vacio) {
    await prisma.ubigeo.createMany({ data: [
      { codigo: '150000', nombre: 'Lima', nivel: 1, padre: null, version },
      { codigo: '150100', nombre: 'Lima', nivel: 2, padre: '150000', version },
      { codigo: '150101', nombre: 'Lima', nivel: 3, padre: '150100', version },
      { codigo: '080000', nombre: 'Cusco', nivel: 1, padre: null, version },
      { codigo: '080100', nombre: 'Cusco', nivel: 2, padre: '080000', version },
      { codigo: '080101', nombre: 'Cusco', nivel: 3, padre: '080100', version },
    ] })
  }
  const creados: string[] = []

  try {
    // ── Preparación ──────────────────────────────────────────────────────
    const mkNegocio = async (tag: string, opts: { demo?: boolean } = {}) => {
      const t = await prisma.tenant.create({ data: { slug: `fr-${tag}-${randomUUID().slice(0, 6)}`, name: `Real ${tag}`, legalName: `REAL ${tag.toUpperCase()} SAC`, taxId: ruc(), planId: plan.id, isDemo: !!opts.demo } })
      creados.push(t.id)
      await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_fr' } })
      const { branch, warehouse: w } = await crearSucursalConAlmacen(t.id)
      const u = await prisma.user.create({ data: { tenantId: t.id, email: `o-${randomUUID()}@x.com`, name: 'Dueño', role: 'OWNER' } })
      await asignarSucursal(t.id, u.id, branch.id)
      const ctx: TenantContext = { tenantId: t.id, userId: u.id, role: 'OWNER', access: 'FULL', branchId: branch.id, branchIds: [branch.id] }
      const db = getTenantPrisma(ctx)
      const p = await prisma.product.create({ data: { tenantId: t.id, sku: 'P', name: 'Producto', salePrice: 10 } })
      await prisma.stock.create({ data: { tenantId: t.id, productId: p.id, warehouseId: w.id, quantity: 1000 } })
      const cli = await prisma.customer.create({ data: { tenantId: t.id, docType: 'DNI', docNumber: '41235678', name: 'María Flores' } })
      const boleta = async () => {
        const v = await registerSale(db, ctx, registerSaleSchema.parse({ warehouseId: w.id, customerId: cli.id, items: [{ productId: p.id, quantity: 2 }], payments: [{ method: 'EFECTIVO', amount: 20 }], idempotencyKey: randomUUID() }))
        return issueTaxDocument(db, ctx, { saleId: v.saleId, documentType: 'BOLETA' })
      }
      return { t, branch, w, ctx, db, p, boleta, saleId: async () => (await registerSale(db, ctx, registerSaleSchema.parse({ warehouseId: w.id, customerId: cli.id, items: [{ productId: p.id, quantity: 5 }], payments: [{ method: 'EFECTIVO', amount: 50 }], idempotencyKey: randomUUID() }))).saleId }
    }
    const llamadas = { n: 0 }
    const espia: ProveedorFacturacion = { ...obtenerProveedor('mock'), emitir: async (...a) => { llamadas.n++; return obtenerProveedor('mock').emitir(...a) } }

    console.log('\n1) >>> Apagado por defecto: NADA sale hacia el proveedor')
    const A = await mkNegocio('a')
    check('un negocio nuevo nace con la facturación real APAGADA', (await prisma.tenant.findUniqueOrThrow({ where: { id: A.t.id } })).realBillingEnabledAt === null)
    const d1 = await A.boleta()
    check('con la facturación real apagada SÍ puede emitir y numerar (sin regresión)', !!d1.fullNumber)
    check('>>> pero enviar se rechaza con un mensaje claro', (await msg(enviarComprobante(A.db, A.ctx, d1.id, { proveedor: espia, credenciales: cred }))).includes('todavía no está habilitada'))
    check('>>> el proveedor NO fue invocado ni una vez', llamadas.n === 0, String(llamadas.n))
    check('y el comprobante sigue PENDIENTE', (await prisma.taxDocument.findUniqueOrThrow({ where: { id: d1.id } })).status === 'PENDIENTE')
    check('>>> aun con credenciales válidas cargadas, el interruptor manda', llamadas.n === 0)

    console.log('\n2) Encendida: envía')
    await prisma.tenant.update({ where: { id: A.t.id }, data: { realBillingEnabledAt: new Date() } })
    await prisma.branch.update({ where: { id: A.branch.id }, data: { address: 'Av. Los Constructores 123, Lima', ubigeo: '150101' } })
    const r = await enviarComprobante(A.db, A.ctx, d1.id, { proveedor: espia, credenciales: cred })
    check('con el interruptor encendido el comprobante se envía y se acepta', r.estado === 'ACEPTADO' && llamadas.n === 1)

    console.log('\n3) La demo ignora el interruptor y nunca usa un proveedor real')
    const D = await mkNegocio('demo', { demo: true })
    const dd = await D.boleta()
    const rd = await enviarComprobante(D.db, D.ctx, dd.id, { proveedor: espia, credenciales: cred })
    check('una demo envía al simulado aunque el interruptor esté apagado', rd.estado === 'ACEPTADO')
    check('>>> y NO se le exigen requisitos de sucursal', (await faltantesParaEmitir(D.db, D.branch.id)).aplica === false)
    check('>>> una demo no se puede habilitar', await code(cambiarFacturacionReal({ tenantId: D.t.id, habilitar: true, reason: 'Intento sobre una demo' }, { id: 'x', email: 'a@b.c' })) === 'FORBIDDEN_ROLE')

    console.log('\n4) Requisitos de la sucursal para emitir con facturación real')
    const B = await mkNegocio('b')
    check('apagada: no se exige nada (aplica = false)', (await faltantesParaEmitir(B.db, B.branch.id)).aplica === false)
    await prisma.tenant.update({ where: { id: B.t.id }, data: { realBillingEnabledAt: new Date() } })
    const f0 = await faltantesParaEmitir(B.db, B.branch.id)
    check('>>> encendida y sucursal sin datos: faltan dirección y ubigeo, y lo dice', f0.aplica && f0.faltantes.some((x) => x.includes('dirección')) && f0.faltantes.some((x) => x.includes('ubigeo')), f0.faltantes.join(' | '))
    const msgBol = await msg(B.boleta())
    check('>>> emitir una boleta se BLOQUEA con ese detalle', msgBol.includes('falta:') && msgBol.includes('dirección'), msgBol.slice(0, 110))
    check('>>> emitir una guía también', (await msg(emitirGuia(B.db, B.ctx, {
      saleId: await B.saleId(), motive: 'VENTA', transportMode: 'PRIVADO', transferStartDate: manana(), grossWeightKg: 10,
      recipient: { docType: 'DNI', docNumber: '41235678', name: 'María Flores' },
      origin: { address: 'Av. Los Constructores 123, Lima', ubigeo: '150101' }, destination: { address: 'Jr. Las Obras 456, Cusco', ubigeo: '080101' },
      vehicle: { plate: 'ABC123' }, driver: { docType: 'DNI', docNumber: '12345678', name: 'Pedro Condori', license: 'Q12345678' },
      items: [{ productId: B.p.id, quantity: 1 }],
    } as EmitirGuiaInput))).includes('falta:'))
    await prisma.branch.update({ where: { id: B.branch.id }, data: { address: 'corta', ubigeo: '150101' } })
    check('una dirección demasiado corta no cuenta', (await faltantesParaEmitir(B.db, B.branch.id)).faltantes.some((x) => x.includes('dirección')))
    await prisma.branch.update({ where: { id: B.branch.id }, data: { address: 'Av. Los Constructores 123, Lima', ubigeo: '15010' } })
    check('un ubigeo mal formado no cuenta', (await faltantesParaEmitir(B.db, B.branch.id)).faltantes.some((x) => x.includes('ubigeo')))
    await prisma.branch.update({ where: { id: B.branch.id }, data: { ubigeo: '999999' } })
    check('>>> un ubigeo con formato correcto pero que NO está en el catálogo no cuenta', (await faltantesParaEmitir(B.db, B.branch.id)).faltantes.some((x) => x.includes('catálogo')))
    await prisma.branch.update({ where: { id: B.branch.id }, data: { address: 'Av. Los Constructores 123, Lima', ubigeo: '150101' } })
    check('completa: ya no falta nada', (await faltantesParaEmitir(B.db, B.branch.id)).faltantes.length === 0)
    check('y ahora SÍ emite', !!(await B.boleta()).fullNumber)

    console.log('\n5) El ubigeo contra el catálogo')
    check('un distrito que existe', (await distritoExiste('150101')) === true)
    check('>>> uno que no existe se rechaza', (await distritoExiste('999999')) === false && (await code(exigirDistritoValido('999999'))) === 'INVALID_DOCUMENT')
    check('un departamento (no es distrito) no vale como ubigeo de una dirección', (await distritoExiste('150000')) === false)
    check('formato inválido', (await distritoExiste('15A101')) === false)

    console.log('\n6) El interruptor del SuperAdmin: precondiciones')
    const C = await mkNegocio('c')
    await prisma.tenant.update({ where: { id: C.t.id }, data: { taxId: null } })
    const falta = await faltantesParaHabilitar(C.t.id)
    check('>>> sin RUC, sin PSE y sin dirección/ubigeo lo dice todo junto', ['RUC', 'proveedor PSE', 'dirección', 'ubigeo'].every((k) => falta.some((x) => x.includes(k))), falta.join(' | '))
    const actor = { id: (await prisma.user.create({ data: { email: `sa-${randomUUID()}@x.com`, name: 'SA', role: 'SUPERADMIN' } })).id, email: 'soporte@plataforma.pe' }
    check('habilitar con faltantes se rechaza y los nombra', (await msg(cambiarFacturacionReal({ tenantId: C.t.id, habilitar: true, reason: 'Sandbox validado el 12/11' }, actor))).includes('Falta:'))
    check('>>> y NO cambia nada', (await prisma.tenant.findUniqueOrThrow({ where: { id: C.t.id } })).realBillingEnabledAt === null)
    await prisma.tenant.update({ where: { id: C.t.id }, data: { taxId: ruc(), pseConfiguredAt: new Date() } })
    await prisma.branch.update({ where: { id: C.branch.id }, data: { address: 'Av. Los Constructores 123, Lima', ubigeo: '150101' } })
    check('con todo en regla ya no falta nada', (await faltantesParaHabilitar(C.t.id)).length === 0)

    console.log('\n7) Habilitar y apagar, con auditoría y sin carreras')
    const ambos = await Promise.all([1, 2].map(() => cambiarFacturacionReal({ tenantId: C.t.id, habilitar: true, reason: 'Sandbox del PSE validado' }, actor).then(() => 'ok', () => 'no')))
    check('>>> dos SuperAdmin a la vez: gana UNO', ambos.filter((x) => x === 'ok').length === 1, ambos.join())
    check('queda habilitada', (await prisma.tenant.findUniqueOrThrow({ where: { id: C.t.id } })).realBillingEnabledAt !== null)
    const log = await prisma.auditLog.findMany({ where: { tenantId: C.t.id, action: 'tenant.facturacion_real.habilitar' } })
    check('>>> UNA sola auditoría, con motivo y el correo de quien lo hizo', log.length === 1 && log[0]!.reason === 'Sandbox del PSE validado' && log[0]!.actorEmail === 'soporte@plataforma.pe')
    check('habilitar dos veces se rechaza', await code(cambiarFacturacionReal({ tenantId: C.t.id, habilitar: true, reason: 'Otra vez, por si acaso' }, actor)) === 'INVALID_DOCUMENT')
    await cambiarFacturacionReal({ tenantId: C.t.id, habilitar: false, reason: 'El proveedor rechaza el XML' }, actor)
    check('apagar la deja en NULL y se audita', (await prisma.tenant.findUniqueOrThrow({ where: { id: C.t.id } })).realBillingEnabledAt === null
      && (await prisma.auditLog.count({ where: { tenantId: C.t.id, action: 'tenant.facturacion_real.apagar' } })) === 1)
    check('apagar lo ya apagado se rechaza', await code(cambiarFacturacionReal({ tenantId: C.t.id, habilitar: false, reason: 'Nada que apagar aquí' }, actor)) === 'INVALID_DOCUMENT')
    check('un negocio inexistente', await code(cambiarFacturacionReal({ tenantId: 'no-existe', habilitar: true, reason: 'Negocio que no existe' }, actor)) === 'TENANT_MISMATCH')
    await prisma.user.delete({ where: { id: actor.id } }).catch(() => {})

    console.log('\n8) ESTRUCTURA: solo el SuperAdmin puede tocar el interruptor')
    const proj = proyecto()
    const escritores: string[] = []
    for (const f of ficheros(join(RAIZ, 'src'), (p) => p.endsWith('.ts') || p.endsWith('.tsx'))) {
      if (f.includes('/generated/')) continue
      const sf = proj.addSourceFileAtPath(f)
      const escribe = sf.getDescendantsOfKind(SyntaxKind.PropertyAssignment).some((pa) =>
        pa.getName() === 'realBillingEnabledAt' &&
        pa.getParentWhile((n) => n.getKind() !== SyntaxKind.PropertyAssignment || (n as import('ts-morph').PropertyAssignment).getName() !== 'data') !== undefined &&
        pa.getFirstAncestor((a) => a.getKind() === SyntaxKind.PropertyAssignment && (a as import('ts-morph').PropertyAssignment).getName() === 'data') !== undefined)
      if (escribe) escritores.push(rel(f))
    }
    check('>>> el único código de producción que ESCRIBE `realBillingEnabledAt` es el servicio del SuperAdmin',
      escritores.length === 1 && escritores[0] === 'src/features/superadmin/facturacion-real-service.ts', escritores.join(', '))
    const acc = proj.addSourceFileAtPath(join(RAIZ, 'src/features/superadmin/actions.ts'))
    const fn = acc.getFunction('setFacturacionRealAction')
    check('>>> la acción exige requireSuperAdmin antes de llamar al servicio',
      !!fn && fn.getText().indexOf('requireSuperAdmin') !== -1 && fn.getText().indexOf('requireSuperAdmin') < fn.getText().indexOf('cambiarFacturacionReal'))
  } finally {
    if (creados.length) await prisma.tenant.deleteMany({ where: { id: { in: creados } } })
    if (vacio) await prisma.ubigeo.deleteMany({ where: { version } })
  }

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
