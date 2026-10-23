import './guard'
import { correr } from './teardown'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { randomBytes, randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { cifrar } from '../src/lib/cifrado'
import { completarRuc } from '../src/lib/documentos'
import { diaLocal } from '../src/lib/periodos'
import { registerSale } from '../src/features/pos/sale-service'
import { registerSaleSchema } from '../src/features/pos/schemas'
import { issueTaxDocument } from '../src/features/invoicing/service'
import { enviarComprobante, refrescarEstado } from '../src/features/invoicing/envio'
import { credencialesPseDelNegocio, estadoConfigPse, guardarConfigPse, probarConexionPse, quitarConfigPse } from '../src/features/invoicing/pse-config'
import { crearProveedorPseRest } from '../src/features/invoicing/providers'
import { resolverCliente } from '../src/features/pos/cliente-service'
import { crearPadronHttp } from '../src/features/invoicing/padron-http'
import { getDocumentoImprimible } from '../src/features/printing/queries'
import { servidorFalso, json } from './http-falso'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))

const KEY = randomBytes(32).toString('base64')

async function negocio(tag: string) {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({
    data: {
      slug: `pn-${tag}-${randomUUID().slice(0, 6)}`, name: `PSE ${tag}`, planId: plan.id,
      taxId: completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`), legalName: `PSE ${tag.toUpperCase()} S.A.C.`,
      address: 'Av. Prueba 1', ubigeo: '150101',
    },
  })
  const { branch, warehouse: w } = await crearSucursalConAlmacen(t.id)
  await prisma.branch.update({ where: { id: branch.id }, data: { address: 'Av. Prueba 123, Lima', ubigeo: '150101' } })
  await prisma.tenant.update({ where: { id: t.id }, data: { realBillingEnabledAt: new Date() } })
  const mk = async (role: Role) => {
    const u = await prisma.user.create({ data: { tenantId: t.id, email: `${role}-${randomUUID()}@x.com`.toLowerCase(), name: role, role } })
    await asignarSucursal(t.id, u.id, branch.id)
    const ctx: TenantContext = { tenantId: t.id, userId: u.id, role, access: 'FULL', branchId: branch.id, branchIds: [branch.id] }
    return { ctx, db: getTenantPrisma(ctx) }
  }
  const owner = await mk('OWNER'); const admin = await mk('ADMIN'); const cajero = await mk('CAJERO')
  const prod = await prisma.product.create({ data: { tenantId: t.id, sku: 'P', name: 'Producto', salePrice: 32.9 } })
  await prisma.stock.create({ data: { tenantId: t.id, productId: prod.id, warehouseId: w.id, quantity: 1000 } })
  const dni = await prisma.customer.create({ data: { tenantId: t.id, docType: 'DNI', docNumber: '41235678', name: 'María Flores' } })
  const boleta = async () => {
    const v = await registerSale(owner.db, owner.ctx, registerSaleSchema.parse({
      warehouseId: w.id, customerId: dni.id, items: [{ productId: prod.id, quantity: 2 }],
      payments: [{ method: 'YAPE', amount: 65.8 }], idempotencyKey: randomUUID(),
    }))
    return issueTaxDocument(owner.db, owner.ctx, { saleId: v.saleId, documentType: 'BOLETA' })
  }
  return { t, owner, admin, cajero, boleta }
}

async function main() {
  process.env.PSE_MASTER_KEY = KEY
  const A = await negocio('a'); const B = await negocio('b')
  const TOKEN = 'tok_privado_ZZZ_98765'

  console.log('\n1) Guardar las credenciales (cifradas)')
  check('>>> el ADMIN no puede configurar el proveedor (solo el dueño: config.fiscal)', await code(guardarConfigPse(A.admin.db, A.admin.ctx, { url: 'https://api.proveedor.pe/v1', token: TOKEN })) === 'FORBIDDEN_ROLE')
  check('>>> ni el cajero', await code(guardarConfigPse(A.cajero.db, A.cajero.ctx, { url: 'https://api.proveedor.pe/v1', token: TOKEN })) === 'FORBIDDEN_ROLE')
  for (const [url, que] of [['http://api.proveedor.pe', 'http'], ['https://127.0.0.1/x', 'IP'], ['https://localhost/x', 'localhost'], ['https://169.254.169.254/', 'metadatos'], ['https://u:p@api.proveedor.pe/', 'con usuario']] as const) {
    check(`>>> URL ${que} se rechaza`, await code(guardarConfigPse(A.owner.db, A.owner.ctx, { url, token: TOKEN })) === 'INVALID_DOCUMENT')
  }
  check('un token corto se rechaza', await code(guardarConfigPse(A.owner.db, A.owner.ctx, { url: 'https://api.proveedor.pe/v1', token: 'x' })) === 'INVALID_DOCUMENT')
  check('>>> estado inicial: no configurado', (await estadoConfigPse(A.owner.db)).configurado === false)

  // Para guardar hace falta que el nombre resuelva a una IP pública: se usa example.com, que lo hace.
  await guardarConfigPse(A.owner.db, A.owner.ctx, { url: 'https://example.com/pse/', token: TOKEN })
  const fila = await prisma.tenant.findUniqueOrThrow({ where: { id: A.t.id } })
  check('>>> el token NO está en claro en la base', !!fila.pseTokenEnc && !fila.pseTokenEnc.includes(TOKEN) && fila.pseTokenEnc.startsWith('v1.'))
  check('la URL se guarda normalizada (sin barra final)', fila.pseEndpointUrl === 'https://example.com/pse')
  const est = await estadoConfigPse(A.owner.db)
  check('>>> la pantalla solo sabe que está configurado y el host, nunca el token', est.configurado && est.host === 'example.com' && !JSON.stringify(est).includes(TOKEN) && !JSON.stringify(est).includes('pse/'))
  const aud = JSON.stringify(await prisma.auditLog.findMany({ where: { tenantId: A.t.id, action: 'pse.configurar' } }))
  check('>>> la auditoría guarda el host, no el token', aud.includes('example.com') && !aud.includes(TOKEN))
  const cred = await credencialesPseDelNegocio(A.owner.db, A.t.id)
  check('en el servidor se descifra para usarlo', cred?.token === TOKEN && cred.urlBase === 'https://example.com/pse')

  console.log('\n2) Atado a cada negocio y a la clave')
  await prisma.tenant.update({ where: { id: B.t.id }, data: { pseEndpointUrl: 'https://example.com/otro', pseTokenEnc: fila.pseTokenEnc } })
  check('>>> copiar el token cifrado de un negocio a otro NO sirve', await code(credencialesPseDelNegocio(B.owner.db, B.t.id)) === 'INVALID_DOCUMENT')
  const otraClave = randomBytes(32).toString('base64')
  process.env.PSE_MASTER_KEY = otraClave
  check('>>> con otra clave maestra no se puede leer (mensaje claro, no un fallo)', await code(credencialesPseDelNegocio(A.owner.db, A.t.id)) === 'INVALID_DOCUMENT')
  process.env.PSE_MASTER_KEY_PREVIOUS = KEY
  check('con la anterior declarada, la rotación funciona', (await credencialesPseDelNegocio(A.owner.db, A.t.id))?.token === TOKEN)
  delete process.env.PSE_MASTER_KEY_PREVIOUS
  delete process.env.PSE_MASTER_KEY
  check('>>> sin clave maestra no se guarda nada y se explica', await code(guardarConfigPse(A.owner.db, A.owner.ctx, { url: 'https://example.com/pse', token: TOKEN })) === 'INVALID_DOCUMENT' && (await estadoConfigPse(A.owner.db)).claveMaestra === false)
  process.env.PSE_MASTER_KEY = KEY

  console.log('\n3) Envío de punta a punta contra un PSE de pruebas')
  let modo = 'acepta'
  const srv = await servidorFalso(async (req, res) => {
    if (req.ruta === '/salud') return json(res, 200, { ok: true, mensaje: 'Conexión correcta', certificado_vence_en: '2027-01-01' })
    if (req.metodo === 'GET') return json(res, 200, { estado: 'ACEPTADO', hash: 'HASH-FINAL=', codigo: '0', mensaje: 'Aceptada tras consulta' })
    if (modo === 'acepta') return json(res, 200, { estado: 'ACEPTADO', hash: 'DigestValue-OK=', codigo: '0', mensaje: 'Aceptada', id: 'e1', ticket: 't1' })
    if (modo === 'observa') return json(res, 200, { estado: 'OBSERVADO', hash: 'DigestValue-OBS=', codigo: '4001', mensaje: 'Observada: ubigeo' })
    if (modo === 'rechaza') return json(res, 422, { mensaje: 'Receptor inexistente' })
    if (modo === 'caido') return json(res, 503, {})
    if (modo === 'async') return json(res, 202, { estado: 'PENDIENTE', ticket: 'T-ASYNC', id: 'ext-async' })
    if (modo === 'sin-token') return json(res, 401, {})
  })
  // Guardado directo (la URL local no pasaría la validación anti-SSRF de la pantalla).
  await prisma.tenant.update({ where: { id: A.t.id }, data: { pseEndpointUrl: srv.url, pseTokenEnc: cifrar(TOKEN, A.t.id) } })
  const credLocal = (await credencialesPseDelNegocio(A.owner.db, A.t.id))!
  const local = crearProveedorPseRest({ permitirRedLocal: true, timeoutMs: 800 })
  const enviar = (id: string) => enviarComprobante(A.owner.db, A.owner.ctx, id, { proveedor: local, credenciales: credLocal })
  const estadoDe = (id: string) => prisma.taxDocument.findUniqueOrThrow({ where: { id } })

  const d1 = await A.boleta()
  const r1 = await enviar(d1.id)
  const f1 = await estadoDe(d1.id)
  check('>>> ACEPTADO: se guarda hash, código, ticket, id externo y fechas', r1.estado === 'ACEPTADO' && f1.xmlHash === 'DigestValue-OK=' && f1.responseCode === '0' && f1.externalTicket === 't1' && f1.externalId === 'e1' && !!f1.acceptedAt && !!f1.sentAt)
  check('el PSE recibió el token descifrado', srv.peticiones.some((q) => q.cabeceras.authorization === `Bearer ${TOKEN}`))
  modo = 'observa'
  const d2 = await A.boleta(); const r2 = await enviar(d2.id); const f2 = await estadoDe(d2.id)
  check('>>> OBSERVADO: se guarda como tal, con hash y fecha de aceptación', r2.estado === 'OBSERVADO' && f2.status === 'OBSERVADO' && f2.xmlHash === 'DigestValue-OBS=' && f2.responseCode === '4001' && !!f2.acceptedAt)
  modo = 'rechaza'
  const d3 = await A.boleta(); const r3 = await enviar(d3.id); const f3 = await estadoDe(d3.id)
  check('>>> RECHAZADO: motivo guardado, sin hash', r3.estado === 'RECHAZADO' && f3.xmlHash === null && !!f3.rejectedAt && /inexistente/.test(f3.statusMessage ?? ''))
  modo = 'caido'
  const d4 = await A.boleta(); const r4 = await enviar(d4.id)
  check('>>> PSE caído: sigue PENDIENTE y reintentable', r4.estado === 'PENDIENTE' && r4.reintentable && (await estadoDe(d4.id)).status === 'PENDIENTE')
  modo = 'sin-token'
  const d5 = await A.boleta()
  check('>>> token rechazado (401): error de configuración y el comprobante NO cambia', await code(enviar(d5.id)) === 'INVALID_DOCUMENT' && (await estadoDe(d5.id)).status === 'PENDIENTE')
  modo = 'async'
  const d6 = await A.boleta(); const r6 = await enviar(d6.id)
  check('asíncrono: ENVIADO', r6.estado === 'ENVIADO' && (await estadoDe(d6.id)).externalId === 'ext-async')
  const cons = await refrescarEstado(A.owner.db, A.owner.ctx, d6.id, { proveedor: local, credenciales: credLocal })
  const f6 = await estadoDe(d6.id)
  check('>>> al consultar queda ACEPTADO y con el hash que devolvió el PSE', cons.estado === 'ACEPTADO' && f6.xmlHash === 'HASH-FINAL=' && !!f6.acceptedAt)

  console.log('\n4) Sin deps: usa el PSE configurado y la defensa anti-SSRF actúa')
  await prisma.tenant.update({ where: { id: A.t.id }, data: { pseEndpointUrl: 'https://127.0.0.1/pse', pseTokenEnc: cifrar(TOKEN, A.t.id) } })
  const d7 = await A.boleta()
  check('>>> una URL interna guardada a mano NO se contacta: error y el comprobante queda PENDIENTE', await code(enviarComprobante(A.owner.db, A.owner.ctx, d7.id)) === 'INVALID_DOCUMENT' && (await estadoDe(d7.id)).status === 'PENDIENTE')
  await quitarConfigPse(A.owner.db, A.owner.ctx)
  check('quitar la configuración borra URL y token', (await prisma.tenant.findUniqueOrThrow({ where: { id: A.t.id } })).pseTokenEnc === null)
  check('>>> sin proveedor configurado: pendiente de envío', await code(enviarComprobante(A.owner.db, A.owner.ctx, d7.id)) === 'INVALID_DOCUMENT')
  check('probar conexión sin credenciales guardadas lo dice', await code(probarConexionPse(A.owner.db, A.owner.ctx)) === 'INVALID_DOCUMENT')
  await prisma.tenant.update({ where: { id: A.t.id }, data: { pseEndpointUrl: srv.url, pseTokenEnc: cifrar(TOKEN, A.t.id) } })
  const prueba = await probarConexionPse(A.owner.db, A.owner.ctx, local)
  check('probar conexión: ok y vencimiento del certificado', prueba.ok && prueba.certificadoVenceEn === '2027-01-01')
  check('>>> solo el dueño prueba la conexión', await code(probarConexionPse(A.admin.db, A.admin.ctx, local)) === 'FORBIDDEN_ROLE')

  console.log('\n5) >>> QR y hash en el ticket de 80 mm')
  const imp = async (id: string) => getDocumentoImprimible(A.owner.db, 'comprobante', id)
  const iAcept = await imp(d1.id)
  check('ACEPTADO con hash real: lleva QR y hash', !!iAcept.qr && iAcept.hashXml === 'DigestValue-OK=' && iAcept.qr.svg.includes('<svg'))
  const emisor = (await prisma.tenant.findUniqueOrThrow({ where: { id: A.t.id } })).taxId!
  check('>>> la trama es la reglamentaria, con el hash real', iAcept.qr?.trama === `${emisor}|03|${d1.series}|${String(d1.correlativo).padStart(8, '0')}|10.04|65.80|${diaLocal('America/Lima', new Date(iAcept.fecha))}|1|41235678|DigestValue-OK=|`, iAcept.qr?.trama)
  check('OBSERVADO también lleva QR', !!(await imp(d2.id)).qr)
  check('>>> RECHAZADO no lleva QR ni hash', (await imp(d3.id)).qr === null && (await imp(d3.id)).hashXml === null)
  check('>>> PENDIENTE no lleva QR', (await imp(d4.id)).qr === null)
  await prisma.taxDocument.update({ where: { id: d1.id }, data: { xmlHash: null } })
  check('>>> ACEPTADO pero SIN hash: no se imprime un QR a medias', (await imp(d1.id)).qr === null)

  console.log('\n6) Padrón caído NO bloquea la venta en caja')
  const caido = crearPadronHttp({ url: 'http://127.0.0.1:1/x?n={numero}', token: 't', timeoutMs: 300, permitirRedLocal: true })
  const t0 = Date.now()
  const res = await resolverCliente(A.owner.db, A.owner.ctx, { docNumber: completarRuc('2051234567') }, caido)
  check('>>> sin nombre y con el padrón caído: devuelve null + aviso (la pantalla pide el nombre) en pocos ms', res.cliente === null && res.aviso?.motivo === 'NO_DISPONIBLE' && Date.now() - t0 < 2500)
  const conNombre = await resolverCliente(A.owner.db, A.owner.ctx, { docNumber: completarRuc('2051234567'), name: 'Cliente tecleado SAC' }, caido)
  check('y con el nombre tecleado la venta sigue adelante', conNombre.cliente?.name === 'Cliente tecleado SAC' && conNombre.cliente.origen === 'TECLEADO')

  await srv.cerrar()
  await prisma.tenant.deleteMany({ where: { id: { in: [A.t.id, B.t.id] } } })
  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
