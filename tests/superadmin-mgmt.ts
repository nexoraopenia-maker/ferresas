import './guard'
import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { prisma } from '../src/lib/prisma'
import { resetOwnerPassword, updateTenantProfile } from '../src/features/superadmin/tenant-admin-service'
import { resetOwnerPasswordSchema, updateTenantProfileSchema } from '../src/features/superadmin/schemas'
import { verifyCredentials } from '../src/lib/credentials'
import { getRouteSession } from '../src/lib/session'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}
const M = randomUUID().slice(0, 6)

async function main() {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const sa = await prisma.user.create({
    data: { email: `sa-${M}@x.com`, name: 'SA', role: 'SUPERADMIN', passwordHash: await bcrypt.hash('clave-sa-123456', 12) },
  })
  const t = await prisma.tenant.create({
    data: { slug: `mg-${M}`, name: `Ferre Mgmt ${M}`, planId: plan.id, taxId: '20111111111', phone: '999111222' },
  })
  const owner = await prisma.user.create({
    data: { email: `ow-${M}@x.com`, name: 'Dueño', role: 'OWNER', tenantId: t.id, passwordHash: await bcrypt.hash('clave-vieja-123', 12) },
  })
  const actor = { id: sa.id, email: sa.email }

  console.log('\n1) Validación')
  check('reseteo exige motivo de 10+',
    !resetOwnerPasswordSchema.safeParse({ tenantId: t.id, reason: 'corto' }).success)
  check('perfil exige RUC de 11 dígitos',
    !updateTenantProfileSchema.safeParse({ tenantId: t.id, taxId: '123', reason: 'motivo suficiente aqui' }).success)
  check('acepta RUC válido',
    updateTenantProfileSchema.safeParse({ tenantId: t.id, taxId: '20512345678', reason: 'motivo suficiente aqui' }).success)
  check('RUC vacío es válido (borrar el dato)',
    updateTenantProfileSchema.safeParse({ tenantId: t.id, taxId: '', reason: 'motivo suficiente aqui' }).success)

  console.log('\n2) Reseteo de contraseña del dueño')
  const antiguo = Math.floor((Date.now() - 60_000) / 1000)
  check('la sesión del dueño vale antes',
    (await getRouteSession(owner.id, undefined, new Date(), antiguo)) !== null)

  const r = await resetOwnerPassword({ tenantId: t.id, reason: 'El dueño perdió el acceso, verificado' }, actor)
  check('devuelve el correo del dueño', r.userEmail === owner.email)
  check('genera contraseña en grupos de 4', r.temporaryPassword.split('-').length === 4)
  check('la temporal FUNCIONA',
    (await verifyCredentials({ email: owner.email, password: r.temporaryPassword })) !== null)
  check('la vieja ya NO funciona',
    (await verifyCredentials({ email: owner.email, password: 'clave-vieja-123' })) === null)
  check('>>> revoca las sesiones abiertas del dueño',
    (await getRouteSession(owner.id, undefined, new Date(), antiguo)) === null)
  const log = await prisma.auditLog.findFirst({ where: { tenantId: t.id, action: 'tenant.password.reset' } })
  check('queda auditado con motivo', log?.reason === 'El dueño perdió el acceso, verificado')
  check('el log NO guarda la contraseña',
    !JSON.stringify(log?.after).includes(r.temporaryPassword))

  console.log('\n3) LA GUARDA: no se resetea a otro SUPERADMIN')
  const otroSa = await prisma.user.create({
    data: { email: `sa2-${M}@x.com`, name: 'SA2', role: 'SUPERADMIN', tenantId: t.id, passwordHash: 'x' },
  })
  const esc = await resetOwnerPassword(
    { tenantId: t.id, userId: otroSa.id, reason: 'intento de escalada de privilegios' }, actor,
  ).then(() => null).catch((e) => e)
  check('>>> se rechaza (escalada de privilegios)', esc?.code === 'FORBIDDEN_ROLE')
  check('su hash sigue intacto',
    (await prisma.user.findUniqueOrThrow({ where: { id: otroSa.id } })).passwordHash === 'x')

  console.log('\n4) Edición de perfil')
  const u = await updateTenantProfile(
    { tenantId: t.id, taxId: '20512345678', phone: '987654321', reason: 'El cliente corrigió su RUC' },
    actor,
  )
  check('informa de qué cambió', u.cambios.sort().join(',') === 'phone,taxId', u.cambios.join(','))
  const tras = await prisma.tenant.findUniqueOrThrow({ where: { id: t.id } })
  check('guarda el RUC nuevo', tras.taxId === '20512345678')
  check('y el teléfono', tras.phone === '987654321')
  check('NO borró el nombre', tras.name === `Ferre Mgmt ${M}`)

  console.log('\n5) Solo se tocan los campos presentes')
  await updateTenantProfile({ tenantId: t.id, phone: '900000000', reason: 'Solo cambia el telefono' }, actor)
  const solo = await prisma.tenant.findUniqueOrThrow({ where: { id: t.id } })
  check('>>> cambiar el teléfono NO borra el RUC', solo.taxId === '20512345678')
  check('el teléfono sí cambió', solo.phone === '900000000')

  console.log('\n6) Cadena vacía borra el dato')
  await updateTenantProfile({ tenantId: t.id, phone: '', reason: 'El cliente ya no tiene ese numero' }, actor)
  check('teléfono borrado',
    (await prisma.tenant.findUniqueOrThrow({ where: { id: t.id } })).phone === null)

  console.log('\n7) Sin cambios y RUC duplicado')
  check('sin cambios se rechaza',
    await updateTenantProfile({ tenantId: t.id, taxId: '20512345678', reason: 'nada que cambiar aqui' }, actor)
      .then(() => null).catch((e) => e.code) === 'DUPLICATE_CODE')
  const otro = await prisma.tenant.create({
    data: { slug: `mg2-${M}`, name: 'Otra', planId: plan.id },
  })
  check('RUC ya usado por otra cuenta se rechaza',
    await updateTenantProfile({ tenantId: otro.id, taxId: '20512345678', reason: 'RUC repetido a proposito' }, actor)
      .then(() => null).catch((e) => e.code) === 'DUPLICATE_CODE')
  check('tenant inexistente se rechaza',
    await updateTenantProfile({ tenantId: 'no-existe', taxId: '20999999999', reason: 'cuenta que no existe' }, actor)
      .then(() => null).catch((e) => e.code) === 'TENANT_MISMATCH')

  console.log('\n8) Limpieza')
  await prisma.tenant.delete({ where: { id: otro.id } })
  await prisma.tenant.delete({ where: { id: t.id } })
  await prisma.user.delete({ where: { id: sa.id } })
  check('datos de prueba eliminados', (await prisma.tenant.count({ where: { id: t.id } })) === 0)

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  await prisma.$disconnect()
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
