import './guard'
import { correr } from './teardown'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { consultarPadron, obtenerProveedorPadron, padronMock, sinPadron, type ProveedorPadron } from '../src/features/invoicing/padron'
import { resolverCliente } from '../src/features/pos/cliente-service'
import type { TenantContext } from '../src/lib/tenant-context'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))

async function main() {
  const RUC = completarRuc('2051234567')
  // El mock trata como inexistentes los documentos que TERMINAN en 0; en un RUC la
  // última cifra es el verificador, así que se busca un prefijo cuyo verificador sea 0.
  const RUC_NOEXISTE = Array.from({ length: 200 }, (_, i) => completarRuc(`2051234${String(i).padStart(3, '0')}`))
    .find((r) => r.endsWith('0'))!

  console.log('\n1) Proveedores de padrón')
  check('por defecto no hay ninguno (producción no inventa datos)', obtenerProveedorPadron().nombre === 'ninguno')
  check('uno desconocido es un error de configuración', (() => { try { obtenerProveedorPadron('x'); return false } catch { return true } })())
  check('>>> «ninguno» responde NO_DISPONIBLE', (await consultarPadron(RUC, sinPadron)).ok === false)

  console.log('\n2) consultarPadron')
  const inv = await consultarPadron('20131312956', padronMock)
  check('>>> un RUC con dígito mal se rechaza SIN llamar al proveedor', !inv.ok && inv.motivo === 'INVALIDO')
  check('9 dígitos es inválido', (await consultarPadron('123456789', padronMock)).ok === false)
  const ok = await consultarPadron(RUC, padronMock)
  check('un RUC válido devuelve razón social, dirección y estado', ok.ok && ok.datos.nombre.includes('S.A.C.') && ok.datos.estado === 'ACTIVO' && ok.datos.tipo === 'RUC')
  const dni = await consultarPadron('41235678', padronMock)
  check('un DNI devuelve nombre', dni.ok && dni.datos.tipo === 'DNI')
  const nf = await consultarPadron(RUC_NOEXISTE, padronMock)
  check('>>> un documento que no figura es NO_ENCONTRADO', !nf.ok && nf.motivo === 'NO_ENCONTRADO')
  const roto: ProveedorPadron = { nombre: 'roto', consultar: async () => { throw new Error('timeout') } }
  const caido = await consultarPadron(RUC, roto)
  check('>>> si la fuente se cae, NO tira la venta: NO_DISPONIBLE', !caido.ok && caido.motivo === 'NO_DISPONIBLE')

  console.log('\n3) Cliente desde el mostrador')
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const mkT = (tag: string) => prisma.tenant.create({ data: { slug: `pd-${tag}-${randomUUID().slice(0, 6)}`, name: `Padrón ${tag}`, planId: plan.id } })
  const [tA, tB] = await Promise.all([mkT('a'), mkT('b')])
  const ctxDe = async (t: { id: string }): Promise<{ ctx: TenantContext; db: ReturnType<typeof getTenantPrisma> }> => {
    const u = await prisma.user.create({ data: { tenantId: t.id, email: `u-${randomUUID()}@x.com`, name: 'C', role: 'CAJERO' } })
    const ctx: TenantContext = { tenantId: t.id, userId: u.id, role: 'CAJERO', access: 'FULL' }
    return { ctx, db: getTenantPrisma(ctx) }
  }
  const A = await ctxDe(tA)
  const B = await ctxDe(tB)

  check('>>> un RUC mal tecleado se rechaza con un mensaje claro',
    await code(resolverCliente(A.db, A.ctx, { docNumber: '20131312956', name: 'X' })) === 'INVALID_DOCUMENT')
  check('y no creó nada', (await prisma.customer.count({ where: { tenantId: tA.id } })) === 0)

  const conNombre = await resolverCliente(A.db, A.ctx, { docNumber: RUC, name: 'Mi cliente S.A.C.' }, padronMock)
  check('con nombre tecleado se crea con ESE nombre', conNombre.cliente?.name === 'Mi cliente S.A.C.' && conNombre.cliente.origen === 'TECLEADO' && conNombre.cliente.creado)
  const otra = await resolverCliente(A.db, A.ctx, { docNumber: RUC }, padronMock)
  check('>>> la segunda vez lo reconoce y NO consulta ni duplica', otra.cliente?.creado === false && otra.cliente.id === conNombre.cliente?.id)

  const dniDoc = '41235678'
  const delPadron = await resolverCliente(A.db, A.ctx, { docNumber: dniDoc }, padronMock)
  check('>>> sin nombre, el padrón lo completa', delPadron.cliente?.origen === 'PADRON' && delPadron.cliente.name.startsWith('PERSONA DE PRUEBA'))
  const rucPadron = await resolverCliente(A.db, A.ctx, { docNumber: completarRuc('2099999998') }, padronMock)
  const filaRuc = await prisma.customer.findFirstOrThrow({ where: { tenantId: tA.id, docNumber: completarRuc('2099999998') } })
  check('y guarda la dirección oficial', rucPadron.cliente?.origen === 'PADRON' && filaRuc.address === 'AV. FICTICIA 123 - LIMA')

  const sin = await resolverCliente(A.db, A.ctx, { docNumber: completarRuc('2088888888') }, sinPadron)
  check('>>> sin nombre y sin padrón: devuelve null y un aviso (la pantalla pide el nombre)', sin.cliente === null && sin.aviso?.motivo === 'NO_DISPONIBLE')
  const inexist = await resolverCliente(A.db, A.ctx, { docNumber: RUC_NOEXISTE }, padronMock)
  check('un documento que no figura: null y aviso NO_ENCONTRADO', inexist.cliente === null && inexist.aviso?.motivo === 'NO_ENCONTRADO')
  check('>>> y no se crea un cliente fantasma', (await prisma.customer.count({ where: { tenantId: tA.id, docNumber: RUC_NOEXISTE } })) === 0)

  console.log('\n4) Aislamiento')
  const enB = await resolverCliente(B.db, B.ctx, { docNumber: RUC, name: 'Otro negocio' }, padronMock)
  check('>>> el mismo RUC en OTRO negocio es un cliente distinto', enB.cliente?.creado === true && enB.cliente.id !== conNombre.cliente?.id)

  await prisma.tenant.deleteMany({ where: { id: { in: [tA.id, tB.id] } } })
  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
