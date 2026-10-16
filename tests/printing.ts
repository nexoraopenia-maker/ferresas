import './guard'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { enteroALetras, montoALetras } from '@/lib/numero-a-letras'
import { formatearFechaLocal } from '@/lib/fecha-local'
import { getDocumentoImprimible, esTipoImpresion } from '@/features/printing/queries'
import { registerSale } from '@/features/pos/sale-service'
import { registerSaleSchema } from '@/features/pos/schemas'
import { registerQuote } from '@/features/pos/quote-service'
import { registerQuoteSchema } from '@/features/pos/schemas'
import { issueTaxDocument } from '@/features/invoicing/service'
import { createProductExpress } from '@/features/inventory/product-service'
import { createProductExpressSchema } from '@/features/inventory/schemas'
import type { TenantContext } from '@/lib/tenant-context'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}
const M = randomUUID().slice(0, 6)

async function main() {
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n1) Importe en letras (exigido en boletas y facturas)')
  check('cero', enteroALetras(0) === 'CERO', enteroALetras(0))
  check('uno', enteroALetras(1) === 'UNO')
  check('15 es una palabra, no "DIEZ Y CINCO"', enteroALetras(15) === 'QUINCE')
  check('16 lleva tilde: DIECISÉIS', enteroALetras(16) === 'DIECISÉIS')
  check('21 es VEINTIUNO, no "VEINTE Y UNO"', enteroALetras(21) === 'VEINTIUNO')
  check('31 sí lleva Y: TREINTA Y UNO', enteroALetras(31) === 'TREINTA Y UNO')
  check('100 es CIEN', enteroALetras(100) === 'CIEN')
  check('101 es CIENTO UNO, no "CIEN UNO"', enteroALetras(101) === 'CIENTO UNO')
  check('200 es DOSCIENTOS', enteroALetras(200) === 'DOSCIENTOS')
  check('500 es QUINIENTOS, no "CINCOCIENTOS"', enteroALetras(500) === 'QUINIENTOS')
  check('>>> 1000 es MIL, nunca "UN MIL"', enteroALetras(1000) === 'MIL', enteroALetras(1000))
  check('>>> 21000 apocopa: VEINTIÚN MIL', enteroALetras(21_000) === 'VEINTIÚN MIL', enteroALetras(21_000))
  check('>>> 101000 apocopa: CIENTO UN MIL', enteroALetras(101_000) === 'CIENTO UN MIL', enteroALetras(101_000))
  check('1 000 000 es UN MILLÓN', enteroALetras(1_000_000) === 'UN MILLÓN')
  check('2 000 000 pluraliza: DOS MILLONES', enteroALetras(2_000_000) === 'DOS MILLONES')
  check('999 999 999 entra en rango',
    enteroALetras(999_999_999).startsWith('NOVECIENTOS NOVENTA Y NUEVE MILLONES'))
  check('fuera de rango lanza', (() => { try { enteroALetras(1e10); return false } catch { return true } })())
  check('negativo lanza', (() => { try { enteroALetras(-1); return false } catch { return true } })())

  console.log('\n   Formato completo con céntimos')
  check('130.50 → SON: CIENTO TREINTA CON 50/100 SOLES',
    montoALetras(130.5) === 'SON: CIENTO TREINTA CON 50/100 SOLES', montoALetras(130.5))
  check('céntimos con cero a la izquierda: 0.05 → 05/100',
    montoALetras(0.05) === 'SON: CERO CON 05/100 SOLES', montoALetras(0.05))
  check('sin céntimos → 00/100', montoALetras(118) === 'SON: CIENTO DIECIOCHO CON 00/100 SOLES')
  check('>>> redondea en céntimos enteros, sin deriva de coma flotante',
    montoALetras(0.145) === 'SON: CERO CON 15/100 SOLES', montoALetras(0.145))
  check('>>> 1.005 no se convierte en 00/100',
    montoALetras(1.005) === 'SON: UNO CON 01/100 SOLES', montoALetras(1.005))
  check('dólares usan su nombre del catálogo 02',
    montoALetras(10, 'USD') === 'SON: DIEZ CON 00/100 DÓLARES AMERICANOS')
  check('una moneda desconocida no rompe el ticket',
    montoALetras(10, 'clp') === 'SON: DIEZ CON 00/100 CLP')

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n2) EL BUG DE LA FECHA: el servidor corre en UTC, la tienda en Lima')
  // 2026-03-10T02:30:00Z son las 21:30 del 9 de marzo en Lima.
  const nocturna = '2026-03-10T02:30:00.000Z'
  const enLima = formatearFechaLocal(nocturna, 'America/Lima', 'es-PE')
  check('>>> una venta de las 21:30 NO se fecha al día siguiente',
    enLima.startsWith('09/03/2026'), enLima)
  check('y marca la hora local, no la UTC', enLima.includes('21:30'), enLima)
  check('en UTC sí sería el día 10 (control del test)',
    formatearFechaLocal(nocturna, 'UTC', 'es-PE').startsWith('10/03/2026'))
  check('sin hora para fechas de validez',
    formatearFechaLocal(nocturna, 'America/Lima', 'es-PE', { conHora: false }) === '09/03/2026')
  check('una zona inválida degrada a ISO en vez de tumbar la impresión',
    formatearFechaLocal(nocturna, 'Marte/Olympus', 'es-PE').includes('2026-03-10'))
  check('una fecha inválida devuelve guion', formatearFechaLocal('no-es-fecha') === '—')

  console.log('\n   Validación del tipo de documento en la ruta')
  check('acepta venta', esTipoImpresion('venta'))
  check('acepta comprobante', esTipoImpresion('comprobante'))
  check('acepta cotizacion', esTipoImpresion('cotizacion'))
  check('rechaza cualquier otra cosa', !esTipoImpresion('../../etc/passwd'))

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n3) Fixtures')
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'premium' } })
  const t = await prisma.tenant.create({
    data: {
      slug: `print-${M}`, name: `Ferretería Sol ${M}`, planId: plan.id,
      legalName: `COMERCIAL SOL ${M} S.A.C.`, taxId: `206${M.replace(/\D/g, '0')}00`.slice(0, 11),
      address: 'Av. Industrial 1234, Lima', phone: '987654321',
      timezone: 'America/Lima', locale: 'es-PE',
    },
  })
  await prisma.subscription.create({
    data: { tenantId: t.id, planId: plan.id, status: 'ACTIVE' },
  })
  const owner = await prisma.user.create({
    data: { email: `p-${M}@x.com`, name: 'Rosa Quispe', role: 'OWNER', tenantId: t.id },
  })
  const { branch, warehouse: w } = await crearSucursalConAlmacen(t.id, { almacenName: 'Tienda' })
  await asignarSucursal(t.id, owner.id, branch.id)
  const ctx: TenantContext = {
    tenantId: t.id, userId: owner.id, role: 'OWNER', access: 'FULL', branchId: branch.id,
  }
  const db = getTenantPrisma(ctx)

  // Afecto al 18%, a granel (para probar cantidades decimales).
  const cable = await createProductExpress(db, ctx, createProductExpressSchema.parse({
    barcode: `771${M}01`, name: 'Cable THW 14 AWG', salePrice: 4.2,
    initialStock: 500, minStock: 10, warehouseId: w.id, unitType: 'METRO',
  }))
  // Exonerado: tasa 0. Sirve para comprobar que NO se declara como gravado.
  const libro = await db.product.create({
    data: {
      tenantId: t.id, sku: `LIB-${M}`, name: 'Manual de instalaciones',
      salePrice: 25, taxRate: 0, unitType: 'UNIDAD',
    },
  })
  await db.stock.create({
    data: { tenantId: t.id, productId: libro.id, warehouseId: w.id, quantity: 50 },
  })
  const cliente = await db.customer.create({
    data: {
      tenantId: t.id, name: 'María Flores', docType: 'DNI', docNumber: '41235678',
      address: 'Jr. Puno 456, Lima',
    },
  })
  check('fixtures creados', Boolean(cable.productId && libro.id && cliente.id))

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n4) Ticket de venta (nota de venta)')
  const venta = await registerSale(db, ctx, registerSaleSchema.parse({
    warehouseId: w.id,
    customerId: cliente.id,
    items: [
      { productId: cable.productId, quantity: 2.5 }, // 10.50, afecto
      { productId: libro.id, quantity: 1 },          // 25.00, exonerado
    ],
    payments: [{ method: 'EFECTIVO', amount: 50, change: 14.5 }],
  }))
  const tk = await getDocumentoImprimible(db, 'venta', venta.saleId)

  check('título de nota de venta', tk.titulo === 'NOTA DE VENTA', tk.titulo)
  check('lleva el número correlativo de la venta', tk.numero === venta.number, tk.numero)
  check('emisor: nombre comercial', tk.emisor.nombre === `Ferretería Sol ${M}`)
  check('emisor: razón social', tk.emisor.razonSocial === `COMERCIAL SOL ${M} S.A.C.`)
  check('emisor: RUC', tk.emisor.ruc !== null)
  check('emisor: dirección y teléfono', tk.emisor.direccion !== null && tk.emisor.telefono !== null)
  check('receptor con etiqueta de documento', tk.cliente?.docEtiqueta === 'DNI')
  check('receptor con número', tk.cliente?.docNumero === '41235678')
  check('cajero por nombre, no por id', tk.cajero === 'Rosa Quispe')

  // Las claves de DOC_ETIQUETA deben coincidir con el enum CustomerDocType.
  // Una mal escrita no revienta: silencia la línea del documento, que en una
  // factura es un defecto legal. Se comprueban TODOS los valores del enum.
  for (const [tipo, esperado] of [
    ['DNI', 'DNI'], ['RUC', 'RUC'], ['CE', 'C.E.'], ['PASAPORTE', 'Pasaporte'],
  ] as const) {
    const c = await db.customer.create({
      data: {
        tenantId: t.id, name: `Cliente ${tipo}`, docType: tipo,
        docNumber: `DOC-${tipo}-${M}`,
      },
    })
    const v = await registerSale(db, ctx, registerSaleSchema.parse({
      warehouseId: w.id, customerId: c.id,
      items: [{ productId: libro.id, quantity: 1 }],
      payments: [{ method: 'EFECTIVO', amount: 25 }],
    }))
    const d = await getDocumentoImprimible(db, 'venta', v.saleId)
    check(`etiqueta de ${tipo} se imprime como "${esperado}"`,
      d.cliente?.docEtiqueta === esperado, String(d.cliente?.docEtiqueta))
  }
  check('dos líneas de detalle', tk.lineas.length === 2, String(tk.lineas.length))

  const lCable = tk.lineas.find((l) => l.nombre.includes('Cable'))!
  check('cantidad decimal preservada (2.5 m)', lCable.cantidad === 2.5, String(lCable.cantidad))
  check('unidad de medida en la línea', lCable.unitType === 'METRO')
  check('importe de la línea = 10.50', lCable.importe === 10.5, String(lCable.importe))
  check('nombre CONGELADO al vender, no leído del catálogo hoy',
    lCable.nombre === 'Cable THW 14 AWG')

  console.log('\n   Desglose: gravado y exonerado NO se mezclan')
  check('>>> op. gravada = base del cable (10.50 / 1.18 = 8.90)',
    tk.opGravada === 8.9, String(tk.opGravada))
  check('>>> op. exonerada = el libro completo, 25.00',
    tk.opExonerada === 25, String(tk.opExonerada))
  check('el libro NO se declara como gravado', tk.opGravada < 25)
  check('IGV solo sobre lo afecto: 1.60', tk.igv === 1.6, String(tk.igv))
  check('total = 35.50', tk.total === 35.5, String(tk.total))
  check('gravada + exonerada + IGV = total',
    Math.abs(tk.opGravada + tk.opExonerada + tk.igv - tk.total) < 0.005)
  check('tasa única detectada entre las líneas afectas', tk.tasaIgv === 0.18, String(tk.tasaIgv))
  check('importe en letras coincide con el total',
    tk.totalEnLetras === 'SON: TREINTA Y CINCO CON 50/100 SOLES', tk.totalEnLetras)

  console.log('\n   Pagos')
  check('un pago en efectivo', tk.pagos.length === 1 && tk.pagos[0]!.metodo === 'EFECTIVO')
  check('recibido = 50', tk.recibido === 50, String(tk.recibido))
  check('vuelto = 14.50', tk.vuelto === 14.5, String(tk.vuelto))
  check('la zona horaria del negocio viaja con el documento', tk.zonaHoraria === 'America/Lima')
  check('avisa de que una nota de venta no es comprobante de pago',
    tk.avisoNoFiscal !== null && /no es un comprobante/i.test(tk.avisoNoFiscal))
  check('sin marca de agua: la venta es válida', tk.marcaAgua === null)

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n5) Comprobante: imprime los importes CONGELADOS')
  const boleta = await issueTaxDocument(db, ctx, {
    saleId: venta.saleId, documentType: 'BOLETA',
  })
  // El negocio corrige su razón social DESPUÉS de emitir. El comprobante ya
  // emitido debe seguir imprimiendo la que llevaba.
  await prisma.tenant.update({
    where: { id: t.id },
    data: { legalName: 'RAZÓN SOCIAL CAMBIADA S.A.C.', name: 'Nombre Nuevo' },
  })
  const cp = await getDocumentoImprimible(db, 'comprobante', boleta.id)

  check('título en dos líneas para la caja del ticket',
    cp.titulo === 'BOLETA DE VENTA\nELECTRÓNICA', JSON.stringify(cp.titulo))
  check('número con serie y correlativo de 8 dígitos',
    /^B001-\d{8}$/.test(cp.numero), cp.numero)
  check('>>> conserva la razón social CONGELADA al emitir',
    cp.emisor.razonSocial === `COMERCIAL SOL ${M} S.A.C.`, String(cp.emisor.razonSocial))
  check('el nombre comercial sí es el actual (no se congela)',
    cp.emisor.nombre === 'Nombre Nuevo', cp.emisor.nombre)
  check('receptor congelado en el comprobante', cp.cliente?.nombre === 'María Flores')
  check('>>> importes del COMPROBANTE, no recalculados de las líneas',
    cp.opGravada === Number(boleta.total) - cp.igv - cp.opExonerada
      || cp.total === Number(boleta.total), String(cp.total))
  check('total idéntico al de la venta', cp.total === 35.5, String(cp.total))
  check('importe en letras presente', cp.totalEnLetras.startsWith('SON:'))
  check('estado tributario visible en el ticket', cp.estadoTributario === 'PENDIENTE')
  check('un comprobante NO lleva aviso de "no fiscal"', cp.avisoNoFiscal === null)
  check('mantiene las líneas de la venta', cp.lineas.length === 2)

  console.log('\n   REGRESIÓN: el ticket interno no puede disfrazarse de boleta')
  // `issueTaxDocument` pone Sale.documentType = BOLETA. Si el título del
  // ticket se leyera de ahí, saldría "BOLETA DE VENTA ELECTRÓNICA" rotulado
  // con el número de la VENTA (V001-…), que no identifica ningún comprobante.
  const tkPost = await getDocumentoImprimible(db, 'venta', venta.saleId)
  check('la venta quedó marcada como BOLETA en la base',
    (await db.sale.findFirstOrThrow({
      where: { id: venta.saleId }, select: { documentType: true },
    })).documentType === 'BOLETA')
  check('>>> y aun así el ticket interno sigue siendo NOTA DE VENTA',
    tkPost.titulo === 'NOTA DE VENTA', tkPost.titulo)
  check('>>> nunca se titula como comprobante', !/BOLETA|FACTURA/.test(tkPost.titulo))
  check('conserva el número de la venta, no el de la boleta',
    tkPost.numero === venta.number && tkPost.numero !== cp.numero)
  check('y avisa de que el comprobante existe y cuál es',
    tkPost.avisoNoFiscal?.includes(cp.numero) === true, String(tkPost.avisoNoFiscal))

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n6) Cotización (la deuda del Frente 3, saldada)')
  const cot = await registerQuote(db, ctx, registerQuoteSchema.parse({
    warehouseId: w.id,
    customerId: cliente.id,
    items: [{ productId: cable.productId, quantity: 10 }],
    validDays: 7,
  }))
  const q = await getDocumentoImprimible(db, 'cotizacion', cot.quoteId)
  check('título COTIZACIÓN', q.titulo === 'COTIZACIÓN')
  check('número propio de la serie de cotizaciones', q.numero === cot.number, q.numero)
  check('lleva fecha de validez impresa', q.validUntil !== null)
  check('una cotización NO registra pagos', q.pagos.length === 0 && q.recibido === 0)
  check('total 42.00 (10 m x 4.20)', q.total === 42, String(q.total))
  check('avisa de que no tiene valor tributario',
    q.avisoNoFiscal !== null && /sin valor tributario/i.test(q.avisoNoFiscal))
  check('vigente: sin marca de agua', q.marcaAgua === null)

  // Vencida: debe salir sellada, para que nadie la cobre a precios viejos.
  await db.quote.update({
    where: { id: cot.quoteId },
    data: { validUntil: new Date(Date.now() - 86_400_000) },
  })
  const qv = await getDocumentoImprimible(db, 'cotizacion', cot.quoteId)
  check('>>> vencida: se imprime con marca de agua VENCIDA', qv.marcaAgua === 'VENCIDA', String(qv.marcaAgua))

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n7) AISLAMIENTO: no se puede imprimir el ticket de otro negocio')
  const t2 = await prisma.tenant.create({
    data: { slug: `print2-${M}`, name: `Ferre Luna ${M}`, planId: plan.id },
  })
  const u2 = await prisma.user.create({
    data: { email: `p2-${M}@x.com`, name: 'Otro', role: 'OWNER', tenantId: t2.id },
  })
  const db2 = getTenantPrisma({
    tenantId: t2.id, userId: u2.id, role: 'OWNER', access: 'FULL',
  })

  const fuga = async (tipo: 'venta' | 'comprobante' | 'cotizacion', id: string) => {
    try {
      await getDocumentoImprimible(db2, tipo, id)
      return 'FUGA'
    } catch (e) {
      return (e as { code?: string }).code ?? 'ERROR'
    }
  }
  check('>>> la venta del tenant A no existe para B', await fuga('venta', venta.saleId) === 'NOT_FOUND')
  check('>>> ni su comprobante', await fuga('comprobante', boleta.id) === 'NOT_FOUND')
  check('>>> ni su cotización', await fuga('cotizacion', cot.quoteId) === 'NOT_FOUND')
  check('un id inexistente también es NOT_FOUND, no un 500',
    await fuga('venta', 'cl0000000000000000000000') === 'NOT_FOUND')

  console.log('\n8) Una cuenta en mora SÍ puede reimprimir (es solo lectura)')
  const dbRO = getTenantPrisma({
    tenantId: t.id, userId: owner.id, role: 'OWNER', access: 'READ_ONLY',
  })
  const roOk = await getDocumentoImprimible(dbRO, 'comprobante', boleta.id)
  check('>>> reimprimir no es escritura: funciona en READ_ONLY',
    roOk.numero === cp.numero, roOk.numero)

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n9) Limpieza')
  for (const id of [t.id, t2.id]) {
    await prisma.taxDocument.deleteMany({ where: { tenantId: id } })
    await prisma.tenant.delete({ where: { id } })
  }
  check('datos de prueba eliminados',
    (await prisma.tenant.count({ where: { id: { in: [t.id, t2.id] } } })) === 0)

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  await prisma.$disconnect()
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
