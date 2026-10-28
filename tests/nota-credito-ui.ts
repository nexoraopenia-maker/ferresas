import './guard'
import { correr } from './teardown'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { updateTaxStatus } from '../src/features/invoicing/service'
import { emitirNotaCreditoSchema } from '../src/features/invoicing/schemas'
import { CODIGOS_NOTA_CREDITO_TOTAL } from '../src/features/invoicing/notas'
import { MOTIVOS_NOTA_CREDITO_TOTAL, nombreMotivo, razonSinNota, type DocParaNota } from '../src/features/invoicing/motivos-nota'
import { FormularioNotaCredito, type DocParaFormulario } from '../src/features/invoicing/components/FormularioNotaCredito'
import { getDocumentoImprimible } from '../src/features/printing/queries'
import type { TenantContext } from '../src/lib/tenant-context'

/** Pantalla de la nota de crédito: reglas visibles, esquema, formulario en cada estado, acción y el candado del estado manual. */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const lee = (p: string) => readFileSync(p, 'utf8')

const ok: DocParaNota = { documentType: 'FACTURA', isTrial: false, status: 'ACEPTADO', series: 'F001', notaTotal: null, tieneIdProveedor: true }
const DOC: DocParaFormulario = { fullNumber: 'F001-00000012', receiverName: 'CLIENTE SAC', receiverDocNumber: '20555555556', currency: 'PEN', total: '118.00', fecha: '24/10/2026' }
const html = (p: Partial<Parameters<typeof FormularioNotaCredito>[0]> = {}) => renderToStaticMarkup(createElement(FormularioNotaCredito, {
  doc: DOC, motivo: '', sustento: '', confirmado: false, estado: 'editando', error: null, emitida: null,
  onMotivo: () => {}, onSustento: () => {}, onConfirmado: () => {}, onEmitir: () => {}, onCerrar: () => {}, ...p,
}))
const botonEmitirDeshabilitado = (h: string) => /<button[^>]*\sdisabled=""[^>]*>(Emitir nota de crédito|Emitiendo…)<\/button>/.test(h)

async function main() {
  console.log('\n1) Una sola fuente de verdad para los motivos')
  check('>>> los motivos de la pantalla son EXACTAMENTE los que acepta el servicio (01, 02, 06)',
    JSON.stringify(MOTIVOS_NOTA_CREDITO_TOTAL.map((m) => m.codigo).sort()) === JSON.stringify([...CODIGOS_NOTA_CREDITO_TOTAL].sort()))
  check('>>> y el esquema Zod acepta exactamente esos', ['01', '02', '06'].every((c) => emitirNotaCreditoSchema.safeParse({ saleId: 'v1', reasonCode: c, reasonDescription: 'Devolución' }).success) &&
    ['03', '04', '07', '13', '99', '', '1'].every((c) => !emitirNotaCreditoSchema.safeParse({ saleId: 'v1', reasonCode: c, reasonDescription: 'Devolución' }).success))
  check('el sustento se recorta y va de 3 a 250', emitirNotaCreditoSchema.parse({ saleId: 'v1', reasonCode: '01', reasonDescription: '  abc  ' }).reasonDescription === 'abc' &&
    !emitirNotaCreditoSchema.safeParse({ saleId: 'v1', reasonCode: '01', reasonDescription: ' ab ' }).success &&
    !emitirNotaCreditoSchema.safeParse({ saleId: 'v1', reasonCode: '01', reasonDescription: 'x'.repeat(251) }).success &&
    emitirNotaCreditoSchema.safeParse({ saleId: 'v1', reasonCode: '01', reasonDescription: 'x'.repeat(250) }).success)
  check('sin la venta no pasa', !emitirNotaCreditoSchema.safeParse({ reasonCode: '01', reasonDescription: 'abc' }).success)
  check('nombreMotivo', nombreMotivo('06') === 'Devolución total' && nombreMotivo('77') === null && nombreMotivo(null) === null)

  console.log('\n2) Cuándo se ofrece el botón')
  check('>>> real, aceptado, con identificador, sin nota → SE PUEDE', razonSinNota(ok, true) === null)
  check('boleta también', razonSinNota({ ...ok, documentType: 'BOLETA', series: 'B007' }, true) === null)
  check('>>> PENDIENTE o ENVIADO → «Disponible cuando SUNAT acepte el comprobante»', ['PENDIENTE', 'ENVIADO'].every((s) => razonSinNota({ ...ok, status: s }, true) === 'Disponible cuando SUNAT acepte el comprobante.'))
  check('>>> OBSERVADO (válido) sí admite la nota; RECHAZADO o ANULADO no', razonSinNota({ ...ok, status: 'OBSERVADO' }, true) === null && ['RECHAZADO', 'ANULADO'].every((s) => (razonSinNota({ ...ok, status: s }, true) ?? '').includes('no admite notas')))
  check('>>> de prueba → no', (razonSinNota({ ...ok, isTrial: true }, false) ?? '').includes('prueba'))
  check('>>> ya tiene la nota → dice cuál', razonSinNota({ ...ok, notaTotal: 'FC01-00000001' }, true) === 'Ya tiene la nota de crédito FC01-00000001.')
  check('>>> serie de sucursal ≥ 100 → explica', (razonSinNota({ ...ok, series: 'F101' }, true) ?? '').includes('1 a 99'))
  check('>>> facturación ACTIVA sin identificador del proveedor → «Consultar»', (razonSinNota({ ...ok, tieneIdProveedor: false }, true) ?? '').includes('Consultar'))
  check('...pero sin facturación activa (demo) el identificador no se exige', razonSinNota({ ...ok, tieneIdProveedor: false }, false) === null)
  check('una nota no admite otra nota', razonSinNota({ ...ok, documentType: 'NOTA_CREDITO' }, true) !== null)

  console.log('\n3) El formulario en cada estado')
  const vacio = html()
  check('>>> muestra el resumen: número, cliente, importe', vacio.includes('F001-00000012') && vacio.includes('CLIENTE SAC') && vacio.includes('PEN 118.00'))
  check('ofrece los 3 motivos con su código y nombre', ['01 · Anulación de la operación', '02 · Anulación por error en el RUC', '06 · Devolución total'].every((t) => vacio.includes(t)) && !vacio.includes('04 ·'))
  check('>>> el aviso de alcance es explícito: anula por completo, NO devuelve stock ni dinero', vacio.includes('anula F001-00000012 por completo') && vacio.includes('No devuelve el stock ni el dinero'))
  check('>>> vacío: «Emitir» está DESHABILITADO', botonEmitirDeshabilitado(vacio))
  const sinConfirmar = html({ motivo: '06', sustento: 'Devolución completa' })
  check('>>> con motivo y sustento pero SIN la casilla → sigue deshabilitado', botonEmitirDeshabilitado(sinConfirmar))
  check('>>> sustento de 2 letras → deshabilitado', botonEmitirDeshabilitado(html({ motivo: '06', sustento: 'ab', confirmado: true })))
  check('>>> sin motivo → deshabilitado', botonEmitirDeshabilitado(html({ motivo: '', sustento: 'Devolución', confirmado: true })))
  const listo = html({ motivo: '06', sustento: 'Devolución completa', confirmado: true })
  check('>>> motivo + sustento + casilla → HABILITADO', !botonEmitirDeshabilitado(listo) && listo.includes('Emitir nota de crédito'))
  check('muestra la ayuda del motivo elegido', listo.includes('El cliente devuelve toda la mercadería'))
  const enviando = html({ motivo: '06', sustento: 'Devolución completa', confirmado: true, estado: 'enviando' })
  check('>>> emitiendo: «Emitiendo…», todo bloqueado (no hay doble clic)', enviando.includes('Emitiendo…') && botonEmitirDeshabilitado(enviando) && /<select[^>]*\sdisabled=""/.test(enviando) && /<textarea[^>]*\sdisabled=""/.test(enviando))
  const conError = html({ error: 'El comprobante F001-00000012 ya tiene una nota de crédito total: FC01-00000001.' })
  check('>>> el error del servicio se muestra tal cual, como alerta', conError.includes('role="alert"') && conError.includes('FC01-00000001'))
  const emitida = html({ estado: 'emitida', emitida: { fullNumber: 'FC01-00000001' } })
  check('>>> emitida: muestra el número, dice que queda PENDIENTE y que se envía sola', emitida.includes('FC01-00000001') && emitida.includes('pendiente') && emitida.includes('se envía sola') && !emitida.includes('<select'))
  check('el sustento escrito no se interpreta como HTML', !html({ sustento: '<img src=x onerror=alert(1)>' }).includes('<img'))

  console.log('\n4) La acción y la conexión (estructura)')
  const actions = lee('src/features/invoicing/actions.ts')
  const cuerpo = actions.slice(actions.indexOf('export async function emitirNotaCreditoAction'), actions.indexOf('PROVEEDOR DE FACTURACIÓN (PSE)'))
  check('>>> la acción valida con Zod ANTES de nada', cuerpo.indexOf('emitirNotaCreditoSchema.safeParse(raw)') > 0 && cuerpo.indexOf('safeParse') < cuerpo.indexOf('withTenant'))
  check('>>> usa withTenant (sesión y negocio) y el servicio con el permiso', cuerpo.includes("withTenant('emitirNotaCreditoAction'") && cuerpo.includes('emitirNotaCreditoTotal(db, ctx, parsed.data)'))
  check('refresca /comprobantes', cuerpo.includes("revalidatePath('/comprobantes')"))
  check('>>> la acción NO decide el negocio ni el usuario desde el cuerpo (solo saleId, motivo y sustento)', !/tenantId|userId/.test(lee('src/features/invoicing/schemas.ts').slice(lee('src/features/invoicing/schemas.ts').indexOf('emitirNotaCreditoSchema'))))
  for (const f of ['EmitirNotaCreditoDialog', 'FormularioNotaCredito', 'TaxDocumentList']) {
    check(`>>> ${f} (cliente) no importa el cliente base de Prisma`, !/from ['"]@\/lib\/prisma['"]/.test(lee(`src/features/invoicing/components/${f}.tsx`)))
  }
  const dialog = lee('src/features/invoicing/components/EmitirNotaCreditoDialog.tsx')
  check('el diálogo no se cierra mientras se emite', /if \(!v && pendiente\) return/.test(dialog))
  const pagina = lee('src/app/(dashboard)/comprobantes/page.tsx')
  check('>>> la página pasa el permiso y el modo de facturación activa', pagina.includes("puedeEmitirNota={puede(ctx, 'comprobantes.anular')") && pagina.includes('facturacionActiva={facturacionActiva}') && pagina.includes("modo === 'REAL' || modo === 'PAUSADO'"))
  check('...y calcula la nota viva y el identificador del proveedor', pagina.includes('notaTotal: d.notes[0]?.fullNumber') && pagina.includes('tieneIdProveedor: !!d.externalId'))
  const lista = lee('src/features/invoicing/components/TaxDocumentList.tsx')
  check('>>> con facturación activa la lista NO ofrece NINGÚN cambio de estado a mano', lista.includes('(facturacionActiva ? [] : SIGUIENTES[estado] ?? [])') && !lista.includes('SIGUIENTES[editando.status]') && !lista.includes('SIGUIENTES[d.status]') && lista.includes('Lo fija el proveedor'))
  check('las notas no ofrecen guía ni impresión', lista.includes('puedeEmitirGuia && !esNota(d)') && lista.includes('Impresión próximamente'))

  console.log('\n5) El candado del estado manual y la impresión (con la base)')
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  async function negocio(tag: string, demo: boolean) {
    const t = await prisma.tenant.create({ data: { slug: `nui-${tag}-${randomUUID().slice(0, 6)}`, name: `UI ${tag}`, legalName: `UI ${tag.toUpperCase()} SAC`, taxId: completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`), planId: plan.id, isDemo: demo, ...(demo ? {} : { realBillingEnabledAt: new Date(Date.now() - 86_400_000) }) } })
    await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_nui' } })
    const { branch, warehouse: w } = await crearSucursalConAlmacen(t.id)
    const u = await prisma.user.create({ data: { tenantId: t.id, email: `o-${randomUUID()}@x.com`, name: 'Dueño', role: 'OWNER' } })
    await asignarSucursal(t.id, u.id, branch.id)
    const ctx: TenantContext = { tenantId: t.id, userId: u.id, role: 'OWNER', access: 'FULL', branchId: branch.id, branchIds: [branch.id] }
    let n = 0
    const doc = async (status: 'PENDIENTE' | 'ENVIADO', tipo: 'BOLETA' | 'NOTA_CREDITO' = 'BOLETA', rel?: string) => {
      const sale = await prisma.sale.create({ data: { tenantId: t.id, branchId: branch.id, warehouseId: w.id, userId: u.id, number: `V-${tag}-${randomUUID().slice(0, 6)}`, status: 'COMPLETADA' } })
      n++
      return prisma.taxDocument.create({ data: { tenantId: t.id, saleId: sale.id, documentType: tipo, series: tipo === 'BOLETA' ? 'B001' : 'BC01', correlativo: n, fullNumber: `${tipo === 'BOLETA' ? 'B001' : 'BC01'}-${String(n).padStart(8, '0')}`, status, subtotal: 10, taxTotal: 1.8, total: 11.8, ...(rel ? { relatedDocumentId: rel, reasonCode: '01', reasonDescription: 'x' } : {}) } })
    }
    return { t, ctx, db: getTenantPrisma(ctx), doc }
  }
  const R = await negocio('real', false); const D = await negocio('demo', true)
  const manual = (N: typeof R, id: string, status: 'ENVIADO' | 'ACEPTADO' | 'RECHAZADO') => updateTaxStatus(N.db, N.ctx, { taxDocumentId: id, status, motivo: 'Prueba automatizada del estado manual' }).then(() => 'ok').catch((e) => e.code as string)
  const r1 = await R.doc('ENVIADO')
  const estado = async (id: string) => (await prisma.taxDocument.findUniqueOrThrow({ where: { id } })).status
  check('>>> negocio REAL: NINGÚN cambio manual se acepta (Enviado, Aceptado, Rechazado) y el comprobante no cambia',
    (await manual(R, r1.id, 'ACEPTADO')) === 'INVALID_DOCUMENT' && (await manual(R, r1.id, 'RECHAZADO')) === 'INVALID_DOCUMENT' && (await manual(R, r1.id, 'ENVIADO')) === 'INVALID_DOCUMENT' &&
    (await estado(r1.id)) === 'ENVIADO')
  check('...con un mensaje que manda a «Consultar»', (await updateTaxStatus(R.db, R.ctx, { taxDocumentId: r1.id, status: 'ACEPTADO', motivo: 'Prueba automatizada' }).catch((e) => e.message as string)).toString().includes('Consultar'))
  check('>>> y no deja rastro de un cambio manual en la auditoría', (await prisma.auditLog.count({ where: { tenantId: R.t.id, action: 'taxdocument.status.manual' } })) === 0)
  const d1 = await D.doc('ENVIADO')
  check('>>> negocio DEMO: «Aceptado» a mano sigue permitido (no envía a un proveedor real)', (await manual(D, d1.id, 'ACEPTADO')) === 'ok')
  await R.t && await prisma.tenant.update({ where: { id: R.t.id }, data: { realBillingPausedAt: new Date() } })
  const r2 = await R.doc('PENDIENTE')
  check('>>> negocio en PAUSA también cuenta como facturación activa (ningún estado a mano)', (await manual(R, r2.id, 'ACEPTADO')) === 'INVALID_DOCUMENT' && (await manual(R, r2.id, 'RECHAZADO')) === 'INVALID_DOCUMENT' && (await manual(R, r2.id, 'ENVIADO')) === 'INVALID_DOCUMENT')
  const nota = await D.doc('PENDIENTE', 'NOTA_CREDITO', d1.id)
  const imp = await getDocumentoImprimible(D.db, 'comprobante', nota.id).then(() => null).catch((e) => e as Error & { code?: string })
  check('>>> imprimir una nota se rechaza con un aviso claro (no sale un ticket de boleta con su número)', imp?.code === 'INVALID_DOCUMENT' && imp.message.includes('aún no está disponible'))
  check('imprimir una boleta normal sigue funcionando', !!(await getDocumentoImprimible(D.db, 'comprobante', d1.id).catch(() => null)))

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}
correr(main)
