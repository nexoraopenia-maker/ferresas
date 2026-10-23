import './guard'
import { correr } from './teardown'
import { randomUUID } from 'node:crypto'
import { abrir, proyecto } from './ast'
import { SyntaxKind } from 'ts-morph'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'
import {
  errorDeDocumento, esLicenciaValida, esPlacaValida, esUbigeoValido, MODALIDADES, MOTIVOS,
  normalizarPlaca, pendientePorProducto,
} from '../src/features/guias/reglas'
import { emitirGuiaSchema, type EmitirGuiaInput } from '../src/features/guias/schemas'
import { anularGuia, borradorDeTransferencia, borradorDeVenta, emitirGuia, listarGuias } from '../src/features/guias/service'
import { serieDeSucursal } from '../src/features/branches/series'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const msg = (p: Promise<unknown>) => p.then(() => '').catch((e) => String(e.message ?? e))
const manana = (n = 0) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)

async function main() {
  console.log('\n1) Reglas puras')
  check('ubigeo: 6 dígitos', esUbigeoValido('150101') && !esUbigeoValido('15010') && !esUbigeoValido('15O101'))
  check('placa: 6 o 7 alfanuméricos, tolera guion y minúsculas', esPlacaValida('abc-123') && esPlacaValida('ABC1234') && !esPlacaValida('AB12') && normalizarPlaca('abc-123') === 'ABC123')
  check('licencia: 8 a 12 alfanuméricos', esLicenciaValida('Q12345678') && !esLicenciaValida('123'))
  check('documento: DNI y RUC se validan; sin documento no vale',
    errorDeDocumento('DNI', '12345678') === null && errorDeDocumento('DNI', '1234') !== null
    && errorDeDocumento('RUC', completarRuc('2012345678')) === null && errorDeDocumento('RUC', '20123456789') !== null
    && errorDeDocumento('SIN_DOCUMENTO', '') !== null && errorDeDocumento('CE', 'AB123456') === null)
  check('motivos con sus códigos de catálogo (⚠️ a verificar): 01 venta, 02 compra, 04 traslado, 13 otros',
    MOTIVOS.VENTA.codigo === '01' && MOTIVOS.COMPRA.codigo === '02' && MOTIVOS.TRASLADO_ESTABLECIMIENTOS.codigo === '04' && MOTIVOS.OTROS.codigo === '13')
  check('modalidades: 01 público, 02 privado', MODALIDADES.PUBLICO.codigo === '01' && MODALIDADES.PRIVADO.codigo === '02')
  const pend = pendientePorProducto(new Map([['a', 10], ['b', 2]]), new Map([['a', 6.5], ['b', 5]]))
  check('pendiente = origen − despachado, nunca negativo', pend.get('a') === 3.5 && pend.get('b') === 0)
  check('la serie sale de la sucursal: sucursal 1 → T001, la 12 → T012', serieDeSucursal('GUIA_REMISION', 1).series === 'T001' && serieDeSucursal('GUIA_REMISION', 12).series === 'T012')

  console.log('\n2) Esquema: campos obligatorios y reglas condicionales')
  const ruc = completarRuc('2098765432')
  const base: EmitirGuiaInput = {
    saleId: 's1', motive: 'VENTA', transportMode: 'PRIVADO', transferStartDate: manana(), grossWeightKg: 12.5,
    recipient: { docType: 'RUC', docNumber: ruc, name: 'Constructora Demo SAC' },
    origin: { address: 'Av. Los Constructores 123, Lima', ubigeo: '150101' },
    destination: { address: 'Jr. Las Obras 456, Cusco', ubigeo: '080101' },
    vehicle: { plate: 'ABC-123' }, driver: { docType: 'DNI', docNumber: '12345678', name: 'Pedro Condori', license: 'Q12345678' },
    items: [{ productId: 'p1', quantity: 2 }],
  }
  const ok = (o: Partial<EmitirGuiaInput>) => emitirGuiaSchema.safeParse({ ...base, ...o })
  const mal = (o: Record<string, unknown>) => emitirGuiaSchema.safeParse({ ...base, ...o })
  const rutas = (r: ReturnType<typeof mal>) => (r.success ? [] : r.error.issues.map((i) => i.path.join('.')))
  check('una guía completa de transporte privado es válida', ok({}).success)
  check('transporte público con RUC y razón social es válido', ok({ transportMode: 'PUBLICO', carrier: { ruc: completarRuc('2011111111'), name: 'Transportes Andes SAC' }, vehicle: undefined, driver: undefined }).success)
  check('>>> sin peso no pasa', rutas(mal({ grossWeightKg: undefined })).includes('grossWeightKg') && rutas(mal({ grossWeightKg: 0 })).includes('grossWeightKg'))
  check('>>> sin dirección de partida o de llegada no pasa', rutas(mal({ origin: { address: '', ubigeo: '150101' } })).includes('origin.address') && rutas(mal({ destination: { address: 'Calle 1', ubigeo: '' } })).includes('destination.ubigeo'))
  check('>>> ubigeo de 6 dígitos', rutas(mal({ destination: { address: 'Jr. Las Obras 456', ubigeo: '8101' } })).includes('destination.ubigeo'))
  check('>>> destinatario con RUC inválido', rutas(mal({ recipient: { docType: 'RUC', docNumber: '20123456789', name: 'X SAC' } })).includes('recipient.docNumber'))
  check('>>> privado: exige placa, conductor y licencia', ['vehicle.plate', 'driver.license'].every((k) => rutas(mal({ vehicle: { plate: 'A1' }, driver: { ...base.driver, license: '1' } })).includes(k)) && rutas(mal({ driver: undefined })).includes('driver.docNumber'))
  check('>>> público: exige RUC y razón social del transportista', rutas(mal({ transportMode: 'PUBLICO', carrier: undefined })).includes('carrier.ruc') && rutas(mal({ transportMode: 'PUBLICO', carrier: { ruc: '123', name: '' } })).includes('carrier.ruc'))
  check('>>> motivo Venta exige la venta; Traslado exige la transferencia', rutas(mal({ saleId: undefined })).includes('saleId') && rutas(mal({ motive: 'TRASLADO_ESTABLECIMIENTOS', saleId: undefined })).includes('transferId'))
  check('>>> motivo Otros exige detalle', rutas(mal({ motive: 'OTROS', saleId: undefined })).includes('motiveDetail') && ok({ motive: 'OTROS', motiveDetail: 'Muestra a obra', saleId: undefined }).success)
  check('compra sin origen es válida', ok({ motive: 'COMPRA', saleId: undefined }).success)
  const vacio = rutas(mal({ grossWeightKg: undefined, destination: { address: 'Jr. Las Obras 456', ubigeo: '' }, vehicle: { plate: '' }, driver: { docType: 'DNI', docNumber: '', name: '', license: '' } }))
  check('>>> TODOS los errores salen a la vez (no de uno en uno)', ['grossWeightKg', 'destination.ubigeo', 'vehicle.plate', 'driver.docNumber', 'driver.name', 'driver.license'].every((k) => vacio.includes(k)), vacio.join(','))
  check('no se vincula a venta Y transferencia', rutas(mal({ transferId: 't1' })).includes('saleId'))
  check('sin productos no pasa; un producto repetido tampoco', rutas(mal({ items: [] })).includes('items') && rutas(mal({ items: [{ productId: 'p1', quantity: 1 }, { productId: 'p1', quantity: 1 }] })).includes('items'))
  check('cantidad cero no pasa', !mal({ items: [{ productId: 'p1', quantity: 0 }] }).success)

  console.log('\n3) Preparar el negocio')
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({ data: { slug: `gr-${randomUUID().slice(0, 8)}`, name: 'Guías', legalName: 'FERRETERIA GUIAS SAC', taxId: completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`), planId: plan.id } })
  const otro = await prisma.tenant.create({ data: { slug: `gr2-${randomUUID().slice(0, 8)}`, name: 'Otro', taxId: completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`), planId: plan.id } })
  const sinRuc = await prisma.tenant.create({ data: { slug: `gr3-${randomUUID().slice(0, 8)}`, name: 'Sin RUC', planId: plan.id } })
  for (const x of [t, otro, sinRuc]) await prisma.subscription.create({ data: { tenantId: x.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_gr' } })
  const mkBranch = (tenantId: string, code: string, n: number, def: boolean, address: string | null, ubigeo: string | null) =>
    prisma.branch.create({ data: { tenantId, code, name: code, establishmentCode: String(n - 1).padStart(4, '0'), seriesNumber: n, isDefault: def, address, ubigeo } })
  const bA = await mkBranch(t.id, 'MATRIZ', 1, true, 'Av. Los Constructores 123, Lima', '150101')
  const bB = await mkBranch(t.id, 'SUR', 2, false, 'Jr. Sur 55, Arequipa', '040101')
  const bO = await mkBranch(otro.id, 'MATRIZ', 1, true, 'Calle Ajena 1', '150101')
  const bS = await mkBranch(sinRuc.id, 'MATRIZ', 1, true, 'Calle 1', '150101')
  const wh = (tenantId: string, branchId: string, c: string) => prisma.warehouse.create({ data: { tenantId, branchId, code: c, name: c, isDefault: true } })
  const wA = await wh(t.id, bA.id, 'WA'); const wB = await wh(t.id, bB.id, 'WB'); const wO = await wh(otro.id, bO.id, 'WO'); await wh(sinRuc.id, bS.id, 'WS')
  const mk = (tenantId: string, role: Role, tag: string) => prisma.user.create({ data: { tenantId, email: `${tag}-${randomUUID()}@x.com`, name: tag, role } })
  const owner = await mk(t.id, 'OWNER', 'dueno'); const vendA = await mk(t.id, 'VENDEDOR', 'vendA'); const vendB = await mk(t.id, 'VENDEDOR', 'vendB')
  const cont = await mk(t.id, 'CONTADOR', 'cont'); const almac = await mk(t.id, 'ALMACENERO', 'alm'); const ownerO = await mk(otro.id, 'OWNER', 'dueno2'); const ownerS = await mk(sinRuc.id, 'OWNER', 'dueno3')
  for (const [u, b] of [[owner, bA], [owner, bB], [vendA, bA], [vendB, bB], [almac, bA], [almac, bB], [cont, bA]] as const) await prisma.userBranch.create({ data: { tenantId: t.id, userId: u.id, branchId: b.id } })
  await prisma.userBranch.create({ data: { tenantId: otro.id, userId: ownerO.id, branchId: bO.id } })
  await prisma.userBranch.create({ data: { tenantId: sinRuc.id, userId: ownerS.id, branchId: bS.id } })
  const prod = (sku: string, name: string) => prisma.product.create({ data: { tenantId: t.id, sku, name, salePrice: 10 } })
  const p1 = await prod('P1', 'Cemento Sol 42.5 kg'); const p2 = await prod('P2', 'Clavos 3"'); const p3 = await prod('P3', 'Martillo')
  const cliente = await prisma.customer.create({ data: { tenantId: t.id, docType: 'RUC', docNumber: completarRuc('2000000001'), name: 'Constructora Los Andes SAC', address: 'Jr. Las Obras 456, Cusco' } })
  const venta = async (branchId: string, warehouseId: string, userId: string, n: string, lineas: Array<[typeof p1, number]>, status: 'COMPLETADA' | 'BORRADOR' = 'COMPLETADA') => {
    const s = await prisma.sale.create({ data: { tenantId: t.id, branchId, warehouseId, userId, customerId: cliente.id, number: n, status } })
    await prisma.saleItem.createMany({ data: lineas.map(([p, q]) => ({ tenantId: t.id, saleId: s.id, productId: p.id, nameSnapshot: p.name, skuSnapshot: p.sku, quantity: q, unitPrice: 10, lineTotal: q * 10 })) })
    return s
  }
  const v1 = await venta(bA.id, wA.id, vendA.id, 'V-G1', [[p1, 10], [p2, 5]])
  const vB = await venta(bB.id, wB.id, vendB.id, 'V-G2', [[p1, 1]])
  const vBorr = await venta(bA.id, wA.id, vendA.id, 'V-G3', [[p1, 1]], 'BORRADOR')
  const ctxDe = (u: { id: string }, role: Role, tenantId: string, branchIds: string[], branchId = branchIds[0]): TenantContext =>
    ({ tenantId, userId: u.id, role, access: 'FULL', branchId, branchIds })
  const cOwner = ctxDe(owner, 'OWNER', t.id, [bA.id, bB.id]); const cVendA = ctxDe(vendA, 'VENDEDOR', t.id, [bA.id]); const cVendB = ctxDe(vendB, 'VENDEDOR', t.id, [bB.id])
  const cCont = ctxDe(cont, 'CONTADOR', t.id, [bA.id]); const cAlm = ctxDe(almac, 'ALMACENERO', t.id, [bA.id, bB.id]); const cOtro = ctxDe(ownerO, 'OWNER', otro.id, [bO.id]); const cSin = ctxDe(ownerS, 'OWNER', sinRuc.id, [bS.id])
  const db = (c: TenantContext) => getTenantPrisma(c)
  const guia = (o: Partial<EmitirGuiaInput> = {}): EmitirGuiaInput => ({ ...base, saleId: v1.id, items: [{ productId: p1.id, quantity: 2 }], ...o })

  console.log('\n4) Emitir desde una venta')
  const g1 = await emitirGuia(db(cVendA), cVendA, guia())
  check('>>> numera T001-00000001 desde la sucursal de la venta', g1.fullNumber === 'T001-00000001' && g1.series === 'T001' && g1.correlativo === 1, g1.fullNumber)
  check('queda PENDIENTE (no hay proveedor: no se finge enviada)', g1.status === 'PENDIENTE')
  const fila = await prisma.dispatchGuide.findUniqueOrThrow({ where: { id: g1.id }, include: { items: true } })
  check('congela el emisor (RUC y razón social)', fila.issuerTaxId === t.taxId && fila.issuerLegalName === 'FERRETERIA GUIAS SAC')
  check('guarda destinatario, direcciones y ubigeos', fila.recipientDocNumber === ruc && fila.originUbigeo === '150101' && fila.destinationAddress.includes('Cusco'))
  check('transporte privado: placa normalizada, conductor y licencia', fila.vehiclePlate === 'ABC123' && fila.driverName === 'Pedro Condori' && fila.driverLicense === 'Q12345678' && fila.carrierRuc === null)
  check('líneas con el nombre congelado', fila.items.length === 1 && fila.items[0]!.nameSnapshot === 'Cemento Sol 42.5 kg' && Number(fila.items[0]!.quantity) === 2)
  check('día civil de emisión y fecha de inicio', fila.issueDate.toISOString().slice(0, 10) <= manana(1) && fila.transferStartDate.toISOString().slice(0, 10) === manana())
  check('autor = quien la emitió', fila.createdById === vendA.id)
  check('quedó auditada', (await prisma.auditLog.count({ where: { tenantId: t.id, action: 'guia.emitir', entityId: g1.id } })) === 1)
  const g2 = await emitirGuia(db(cVendA), cVendA, guia({ items: [{ productId: p2.id, quantity: 1 }] }))
  check('>>> el siguiente correlativo no deja huecos', g2.fullNumber === 'T001-00000002')

  console.log('\n5) Nunca se despacha más de lo vendido')
  check('>>> pasarse de lo pendiente se rechaza y dice cuánto queda', (await msg(emitirGuia(db(cVendA), cVendA, guia({ items: [{ productId: p1.id, quantity: 9 }] })))).includes('solo quedan 8'))
  check('un producto que no es de la venta se rechaza', (await msg(emitirGuia(db(cVendA), cVendA, guia({ items: [{ productId: p3.id, quantity: 1 }] })))).includes('no forma parte'))
  const g3 = await emitirGuia(db(cVendA), cVendA, guia({ items: [{ productId: p1.id, quantity: 8 }] }))
  check('despachar exactamente lo que queda sí', g3.correlativo === 3)
  check('>>> ya despachado por completo', (await msg(emitirGuia(db(cVendA), cVendA, guia({ items: [{ productId: p1.id, quantity: 1 }] })))).includes('por completo'))
  const nums = (await prisma.dispatchGuide.findMany({ where: { tenantId: t.id, series: 'T001' }, orderBy: { correlativo: 'asc' } })).map((g) => g.correlativo)
  check('>>> los rechazos NO consumen número (siguen 1,2,3)', nums.join() === '1,2,3', nums.join())

  console.log('\n6) Emisiones simultáneas de la misma venta')
  const v4 = await venta(bA.id, wA.id, vendA.id, 'V-G4', [[p3, 5]])
  const carrera = await Promise.all([1, 2, 3].map(() => emitirGuia(db(cVendA), cVendA, guia({ saleId: v4.id, items: [{ productId: p3.id, quantity: 3 }] })).then(() => 'ok', () => 'no')))
  check('>>> con 5 vendidos, tres guías de 3 a la vez: gana UNA', carrera.filter((x) => x === 'ok').length === 1, carrera.join())
  const tras = (await prisma.dispatchGuide.findMany({ where: { tenantId: t.id, series: 'T001' }, orderBy: { correlativo: 'asc' } })).map((g) => g.correlativo)
  check('>>> y la numeración sigue sin huecos (1,2,3,4)', tras.join() === '1,2,3,4', tras.join())

  console.log('\n7) Anular')
  check('>>> el vendedor no puede anular', await code(anularGuia(db(cVendA), cVendA, { guideId: g3.id, reason: 'Error de cantidades' })) === 'FORBIDDEN_ROLE')
  await anularGuia(db(cOwner), cOwner, { guideId: g3.id, reason: 'Error de cantidades' })
  const anulada = await prisma.dispatchGuide.findUniqueOrThrow({ where: { id: g3.id } })
  check('el dueño la anula: queda el motivo y conserva su número', anulada.voidedAt !== null && anulada.voidReason === 'Error de cantidades' && anulada.correlativo === 3)
  check('anulada y auditada', (await prisma.auditLog.count({ where: { tenantId: t.id, action: 'guia.anular', entityId: g3.id } })) === 1)
  check('anular dos veces se rechaza', await code(anularGuia(db(cOwner), cOwner, { guideId: g3.id, reason: 'Otra vez' })) === 'INVALID_DOCUMENT')
  const g5 = await emitirGuia(db(cVendA), cVendA, guia({ items: [{ productId: p1.id, quantity: 8 }] }))
  check('>>> una guía anulada libera lo despachado, pero su número NO se reutiliza', g5.correlativo === 5, g5.fullNumber)
  await prisma.dispatchGuide.update({ where: { id: g5.id }, data: { status: 'ENVIADO' } })
  check('>>> una guía ya transmitida no se anula desde aquí', await code(anularGuia(db(cOwner), cOwner, { guideId: g5.id, reason: 'Ya salió hacia SUNAT' })) === 'INVALID_DOCUMENT')

  console.log('\n8) Permisos')
  check('>>> el contador no emite', await code(emitirGuia(db(cCont), cCont, guia())) === 'FORBIDDEN_ROLE')
  const g6 = await emitirGuia(db(cAlm), cAlm, guia({ saleId: vB.id, items: [{ productId: p1.id, quantity: 1 }] }))
  check('el almacenero sí emite, y la serie es la de la sucursal de la venta (T002)', g6.fullNumber === 'T002-00000001', g6.fullNumber)

  console.log('\n9) Aislamiento por negocio y por sucursal')
  check('>>> otro negocio no puede emitir desde mi venta', await code(emitirGuia(db(cOtro), cOtro, guia())) === 'TENANT_MISMATCH')
  check('>>> otro negocio no ve ni anula mis guías', await code(anularGuia(db(cOtro), cOtro, { guideId: g2.id, reason: 'Intento ajeno' })) === 'TENANT_MISMATCH')
  check('>>> otro negocio no las lista', (await listarGuias(db(cOtro))).length === 0)
  check('>>> un vendedor de otra sucursal no puede emitir desde una venta que no es de la suya', await code(emitirGuia(db(cVendB), cVendB, guia())) === 'TENANT_MISMATCH')
  check('y tampoco las lista', (await listarGuias(db(cVendB))).every((g) => g.fullNumber.startsWith('T002')))
  check('una venta en borrador no admite guía', await code(emitirGuia(db(cVendA), cVendA, guia({ saleId: vBorr.id }))) === 'INVALID_DOCUMENT')

  console.log('\n10) Reglas del negocio')
  check('>>> sin RUC del negocio no se emite', await code(emitirGuia(db(cSin), cSin, guia({ saleId: undefined, motive: 'COMPRA' }))) === 'INVALID_DOCUMENT')
  check('>>> el inicio del traslado no puede ser anterior a la emisión', await code(emitirGuia(db(cVendA), cVendA, guia({ transferStartDate: manana(-3) }))) === 'INVALID_DOCUMENT')
  const gl = await emitirGuia(db(cVendA), cVendA, guia({ saleId: undefined, motive: 'COMPRA', items: [{ productId: p3.id, quantity: 4 }] }))
  check('una guía sin venta (compra) se emite desde la sucursal activa', gl.fullNumber === 'T001-00000006', gl.fullNumber)
  check('un producto inexistente se rechaza', await code(emitirGuia(db(cVendA), cVendA, guia({ saleId: undefined, motive: 'COMPRA', items: [{ productId: 'nope', quantity: 1 }] }))) === 'TENANT_MISMATCH')

  console.log('\n11) Borrador precargado')
  const b = await borradorDeVenta(db(cVendA), cVendA, v1.id)
  check('destinatario y dirección de llegada salen del cliente de la venta', b.recipient.docNumber === cliente.docNumber && b.destination.address.includes('Cusco'))
  check('la partida sale de la sucursal', b.origin.address.includes('Constructores') && b.origin.ubigeo === '150101')
  check('>>> propone solo lo que falta: el cemento ya está despachado por completo (2 + 8) y no se ofrece; quedan 4 clavos',
    !b.items.some((i) => i.productId === p1.id) && b.items.find((i) => i.productId === p2.id)?.max === 4, JSON.stringify(b.items.map((i) => [i.sku, i.max])))
  check('el contador no puede pedir el borrador', await code(borradorDeVenta(db(cCont), cCont, v1.id)) === 'FORBIDDEN_ROLE')

  console.log('\n12) Traslado entre almacenes')
  const tr = async (status: 'BORRADOR' | 'APROBADA', n: string) => {
    const x = await prisma.branchTransfer.create({ data: { tenantId: t.id, number: n, fromBranchId: bA.id, fromWarehouseId: wA.id, toBranchId: bB.id, toWarehouseId: wB.id, status, requestedById: owner.id } })
    await prisma.branchTransferItem.createMany({ data: [{ tenantId: t.id, transferId: x.id, productId: p1.id, nameSnapshot: p1.name, skuSnapshot: p1.sku, quantitySent: 6 }] })
    return x
  }
  const trBorr = await tr('BORRADOR', 'T-G1'); const trOk = await tr('APROBADA', 'T-G2')
  const gt = (o: Partial<EmitirGuiaInput> = {}) => guia({ saleId: undefined, transferId: trOk.id, motive: 'TRASLADO_ESTABLECIMIENTOS', items: [{ productId: p1.id, quantity: 4 }], ...o })
  check('>>> una transferencia sin aprobar no admite guía', await code(emitirGuia(db(cAlm), cAlm, gt({ transferId: trBorr.id }))) === 'INVALID_DOCUMENT')
  check('>>> la guía la emite quien despacha: la sucursal destino no puede', await code(emitirGuia(db(cVendB), cVendB, gt())) !== null)
  const bt = await borradorDeTransferencia(db(cAlm), cAlm, trOk.id)
  check('el destinatario por defecto es el propio negocio; llegada = sucursal destino', bt.recipient.docNumber === t.taxId && bt.destination.address.includes('Arequipa') && bt.motive === 'TRASLADO_ESTABLECIMIENTOS')
  const gT = await emitirGuia(db(cAlm), cAlm, gt())
  check('se emite desde la sucursal de ORIGEN (T001) y vinculada a la transferencia', gT.series === 'T001' && (await prisma.dispatchGuide.findUniqueOrThrow({ where: { id: gT.id } })).transferId === trOk.id)
  check('>>> no se despacha más de lo enviado (6): quedan 2', (await msg(emitirGuia(db(cAlm), cAlm, gt({ items: [{ productId: p1.id, quantity: 3 }] })))).includes('solo quedan 2'))

  console.log('\n13) Estructura')
  const sf = abrir(proyecto(), 'src/features/guias/components/GuiaForm.tsx')
  const campo = sf.getFunction('Campo')
  check('>>> «Campo» está a nivel de módulo (dentro del formulario, cada tecla desmontaría el campo y perdería el foco)', !!campo && campo.getParent()?.getKind() === SyntaxKind.SourceFile)
  check('el formulario no declara componentes dentro de sí mismo',
    sf.getFunctions().filter((f) => f.getName() === 'GuiaForm').every((f) => f.getDescendantsOfKind(SyntaxKind.VariableDeclaration).every((v) => !/^[A-Z]/.test(v.getName()))))

  await prisma.tenant.deleteMany({ where: { id: { in: [t.id, otro.id, sinRuc.id] } } })
  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
