import './guard'
import { correr } from './teardown'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import bcrypt from 'bcryptjs'
import { prisma } from '../src/lib/prisma'
import { completarRuc } from '../src/lib/documentos'
import { verifyCredentialsDetailed } from '../src/lib/credentials'
import { darDeBajaDefinitiva } from '../src/features/superadmin/tenant-admin-service'
import { bajaDefinitivaSchema } from '../src/features/superadmin/schemas'
import { getSuperAdminDashboard } from '../src/features/superadmin/queries'
import { asignarSucursal, credencialSunatFalsa, crearSucursalConAlmacen } from './fixtures'

/**
 * Baja DEFINITIVA de una ferretería desde el panel del SuperAdmin: confirmación escrita, motivo, salvaguardas, y que la cuenta quede inerte SIN perder los datos
 * (comprobantes y archivos fiscales se conservan).
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const msg = (p: Promise<unknown>) => p.then(() => '', (e) => String(e.message))
const M = randomUUID().slice(0, 6)

async function cuerpo() {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const sa = await prisma.user.create({ data: { email: `sa-${M}@x.com`, name: 'SA', role: 'SUPERADMIN', passwordHash: await bcrypt.hash('clave-sa-123456', 12) } })
  const actor = { id: sa.id, email: sa.email }
  const creados: string[] = []

  async function negocio(tag: string, o: { demo?: boolean } = {}) {
    const nombre = `Ferretería ${tag} ${M}`
    const taxId = completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)
    const t = await prisma.tenant.create({ data: { slug: `bd-${tag}-${M}`, name: nombre, legalName: nombre.toUpperCase(), taxId, planId: plan.id, isDemo: !!o.demo, realBillingEnabledAt: new Date(Date.now() - 864e5) } })
    creados.push(t.id)
    await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_bd' } })
    const { branch, warehouse: w } = await crearSucursalConAlmacen(t.id)
    const hash = await bcrypt.hash('clave-123456', 4)
    const owner = await prisma.user.create({ data: { tenantId: t.id, email: `ow-${tag}-${M}@x.com`, name: 'Dueño', role: 'OWNER', passwordHash: hash } })
    const cajero = await prisma.user.create({ data: { tenantId: t.id, email: `ca-${tag}-${M}@x.com`, name: 'Cajero', role: 'CAJERO', passwordHash: hash } })
    await asignarSucursal(t.id, owner.id, branch.id)
    const p = await prisma.product.create({ data: { tenantId: t.id, sku: 'P', name: 'Cemento', salePrice: 11.8 } })
    let n = 0
    const doc = async (status: 'PENDIENTE' | 'ACEPTADO', trial = false) => {
      const sale = await prisma.sale.create({ data: { tenantId: t.id, branchId: branch.id, warehouseId: w.id, userId: owner.id, number: `V-${tag}-${randomUUID().slice(0, 6)}`, status: 'COMPLETADA' } })
      await prisma.saleItem.create({ data: { tenantId: t.id, saleId: sale.id, productId: p.id, nameSnapshot: 'Cemento', skuSnapshot: 'P', quantity: 1, unitPrice: 11.8, lineTotal: 11.8 } })
      n++
      const serie = trial ? 'PF001' : 'F001'
      return prisma.taxDocument.create({ data: { tenantId: t.id, saleId: sale.id, documentType: 'FACTURA', series: serie, correlativo: n, fullNumber: `${serie}-${String(n).padStart(8, '0')}`, status, isTrial: trial, receiverDocType: 'RUC', receiverDocNumber: completarRuc('2055555555'), receiverName: 'C', subtotal: 10, taxTotal: 1.8, total: 11.8 } })
    }
    const tt = () => prisma.tenant.findUniqueOrThrow({ where: { id: t.id } })
    return { t, nombre, owner, cajero, doc, tt, hash }
  }
  const entrada = (A: { t: { id: string }; nombre: string }, o: Partial<{ reason: string; confirmacion: string }> = {}) => ({ tenantId: A.t.id, reason: 'El cliente cerró su negocio y pidió la baja', confirmacion: A.nombre, ...o })

  console.log('\n1) Confirmación y motivo')
  const A = await negocio('a')
  await credencialSunatFalsa(A.t.id, { ruc: A.t.taxId })
  const imp = await prisma.impersonationSession.create({ data: { superAdminId: sa.id, tenantId: A.t.id, reason: 'soporte de prueba', expiresAt: new Date(Date.now() + 36e5) } })
  check('el esquema exige motivo de 10+ caracteres', !bajaDefinitivaSchema.safeParse({ tenantId: A.t.id, reason: 'corto', confirmacion: A.nombre }).success && bajaDefinitivaSchema.safeParse(entrada(A)).success)
  const intactoA = async () => { const t = await A.tt(); return t.deletedAt === null && t.isActive && (await prisma.user.count({ where: { tenantId: A.t.id, isActive: true } })) === 2 }
  check('>>> sin escribir el nombre (vacío) se rechaza y no cambia nada', await code(darDeBajaDefinitiva(entrada(A, { confirmacion: '' }), actor)) === 'INVALID_DOCUMENT' && await intactoA())
  check('>>> con otro nombre, o solo una parte, se rechaza y no cambia nada', await code(darDeBajaDefinitiva(entrada(A, { confirmacion: 'Otra ferretería' }), actor)) === 'INVALID_DOCUMENT' && await code(darDeBajaDefinitiva(entrada(A, { confirmacion: A.nombre.slice(0, 8) }), actor)) === 'INVALID_DOCUMENT' && await intactoA())
  check('>>> el servidor comprueba el nombre aunque la pantalla se saltara (mensaje claro)', /no coincide/.test(await msg(darDeBajaDefinitiva(entrada(A, { confirmacion: 'x' }), actor))))
  check('un motivo corto se rechaza también en el servicio', await code(darDeBajaDefinitiva(entrada(A, { reason: 'corto' }), actor)) === 'INVALID_DOCUMENT' && await intactoA())
  check('una cuenta que no existe → TENANT_MISMATCH', await code(darDeBajaDefinitiva({ tenantId: 'no-existe', reason: 'motivo suficiente', confirmacion: 'x' }, actor)) === 'TENANT_MISMATCH')

  console.log('\n2) Salvaguardas fiscales')
  const B = await negocio('b')
  const pend = await B.doc('PENDIENTE')
  check('>>> con un comprobante real PENDIENTE de enviar no se da de baja (quedaría varado) y dice cuántos', /1 comprobante/.test(await msg(darDeBajaDefinitiva(entrada(B), actor))) && (await B.tt()).deletedAt === null)
  await prisma.taxDocument.update({ where: { id: pend.id }, data: { status: 'ACEPTADO' } })
  const dBaja = await B.doc('ACEPTADO')
  const bajaViva = await prisma.taxVoid.create({ data: { tenantId: B.t.id, taxDocumentId: dBaja.id, issueDay: '2026-10-29', seq: 1, identifier: 'RA-20261029-1', reason: 'x' } })
  check('>>> ni con una baja por resolver ante SUNAT', /1 baja/.test(await msg(darDeBajaDefinitiva(entrada(B), actor))))
  await prisma.taxVoid.update({ where: { id: bajaViva.id }, data: { status: 'RECHAZADA' } })
  await B.doc('PENDIENTE', true)
  check('un documento de PRUEBA pendiente y una baja ya resuelta NO impiden la baja de la cuenta', (await darDeBajaDefinitiva(entrada(B), actor)).usuariosDesactivados === 2)

  console.log('\n3) La baja deja la cuenta inerte y conserva los datos')
  const antesDocs = await prisma.taxDocument.count({ where: { tenantId: A.t.id } })
  const r = await darDeBajaDefinitiva(entrada(A, { confirmacion: `  ${A.nombre.toUpperCase()}  ` }), actor)
  const tA = await A.tt()
  check('>>> el nombre se compara sin distinguir mayúsculas ni espacios de los bordes', r.usuariosDesactivados === 2)
  check('>>> queda marcada como eliminada e inactiva, con el motivo a la vista', tA.deletedAt !== null && tA.isActive === false && tA.suspendedAt !== null && /^BAJA DEFINITIVA: El cliente cerró/.test(tA.suspendedReason ?? ''))
  check('>>> TODOS sus usuarios quedan desactivados', (await prisma.user.count({ where: { tenantId: A.t.id, isActive: true } })) === 0)
  const intento = await verifyCredentialsDetailed({ email: A.owner.email, password: 'clave-123456' })
  check('>>> y nadie puede iniciar sesión (ni el dueño ni el cajero)', !intento.ok && (await verifyCredentialsDetailed({ email: A.cajero.email, password: 'clave-123456' })).ok === false, JSON.stringify(intento).slice(0, 80))
  const sub = await prisma.subscription.findUniqueOrThrow({ where: { tenantId: A.t.id } })
  check('la suscripción local queda CANCELADA', sub.status === 'CANCELED' && sub.canceledAt !== null && r.suscripcionCancelada)
  check('las sesiones de soporte abiertas se cierran', (await prisma.impersonationSession.findUniqueOrThrow({ where: { id: imp.id } })).endedAt !== null)
  check('>>> las credenciales de SUNAT (certificado y clave SOL) se BORRAN', (await prisma.sunatCredential.count({ where: { tenantId: A.t.id } })) === 0 && r.credencialesSunatBorradas)
  check('>>> pero los datos se CONSERVAN: productos, ventas y comprobantes siguen en la base', (await prisma.product.count({ where: { tenantId: A.t.id } })) === 1 && (await prisma.taxDocument.count({ where: { tenantId: A.t.id } })) === antesDocs && (await prisma.tenant.count({ where: { id: A.t.id } })) === 1)
  const aud = await prisma.auditLog.findMany({ where: { tenantId: A.t.id, action: 'tenant.baja_definitiva' } })
  check('>>> la auditoría guarda motivo, correo de quien la dio de baja y qué se cerró', aud.length === 1 && aud[0]!.actorEmail === sa.email && aud[0]!.reason === 'El cliente cerró su negocio y pidió la baja' && JSON.stringify(aud[0]!.after).includes('"usuariosDesactivados":2') && aud[0]!.actorRole === 'SUPERADMIN')
  const panel = await getSuperAdminDashboard()
  check('>>> desaparece de la lista del panel', !panel.tenants.some((x) => x.id === A.t.id) && !panel.tenants.some((x) => x.id === B.t.id))
  check('>>> dar de baja otra vez se rechaza (TENANT_MISMATCH) y no duplica la auditoría', await code(darDeBajaDefinitiva(entrada(A), actor)) === 'TENANT_MISMATCH' && (await prisma.auditLog.count({ where: { tenantId: A.t.id, action: 'tenant.baja_definitiva' } })) === 1)

  console.log('\n4) Concurrencia')
  const C = await negocio('c')
  const dos = await Promise.allSettled([darDeBajaDefinitiva(entrada(C), actor), darDeBajaDefinitiva(entrada(C), actor)])
  check('>>> dos SuperAdmin a la vez: una sola baja y una sola auditoría', dos.filter((x) => x.status === 'fulfilled').length === 1 && (await prisma.auditLog.count({ where: { tenantId: C.t.id, action: 'tenant.baja_definitiva' } })) === 1)

  console.log('\n5) Solo el SuperAdmin, y la pantalla pide el nombre')
  const acciones = readFileSync('src/features/superadmin/actions.ts', 'utf8')
  const eliminar = acciones.slice(acciones.indexOf('export async function eliminarTenantAction'))
  check('>>> la acción exige SuperAdmin ANTES de dar de baja', eliminar.indexOf('requireSuperAdmin()') > 0 && eliminar.indexOf('requireSuperAdmin()') < eliminar.indexOf('darDeBajaDefinitiva('))
  const ui = readFileSync('src/features/superadmin/components/TenantActions.tsx', 'utf8')
  check('>>> el botón no se habilita hasta escribir el nombre exacto y un motivo', /accion === 'baja_definitiva'\s*\? reason\.trim\(\)\.length >= 10 && confirmaNombre\.trim\(\)\.toLowerCase\(\) === tenantName\.trim\(\)\.toLowerCase\(\)/.test(ui))
  check('la opción está en el menú, como acción peligrosa, y avisa que es permanente y que la pasarela se cancela aparte', /tone="danger" onSelect=\{\(\) => abrir\('baja_definitiva'\)\}/.test(ui) && /Acción permanente/.test(ui) && /cancélalo allí aparte/.test(ui))

  await prisma.tenant.deleteMany({ where: { id: { in: creados } } })
}

async function main() {
  try { await cuerpo() } catch (e) { check(`EXCEPCIÓN no controlada: ${e instanceof Error ? (e.stack ?? e.message).slice(0, 400) : e}`, false) }
  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}
correr(main)
