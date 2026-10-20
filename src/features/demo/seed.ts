import { randomUUID } from 'node:crypto'
import { BusinessError } from '@/lib/errors'
import { prisma } from '@/lib/prisma'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import type { TenantContext } from '@/lib/tenant-context'
import { registerTenant } from '@/features/onboarding/service'
import { createProductExpress } from '@/features/inventory/product-service'
import { registerSale } from '@/features/pos/sale-service'
import { convertQuoteToSale, registerQuote } from '@/features/pos/quote-service'
import { issueTaxDocument } from '@/features/invoicing/service'
import { closeCashSession, currentCashSession, openCashSession } from '@/features/branches/cash-service'

/**
 * Cuenta de demostración.
 *
 * Una ferretería ficticia, completa y usable, para que quien la visita vea el
 * sistema funcionando sin partir de cero: productos con stock (y algunos en
 * alerta), clientes, cotizaciones, ventas de los últimos días, comprobantes y
 * cajas cerradas y abierta.
 *
 * ─── REGLAS ──────────────────────────────────────────────────────────────
 *
 *  · NO escribe nada "por detrás" en una cuenta real. Todo cuelga de un
 *    tenant con `isDemo = true`, y `prepararCuentaDemo` se niega a tocar un
 *    correo que ya pertenezca a un negocio de verdad.
 *  · Los datos pasan por los MISMOS servicios que usa el POS (venta, cotización,
 *    caja, comprobante), no por inserts sueltos: el libro de movimientos
 *    cuadra con el stock y los correlativos son los de verdad. Después solo se
 *    reescriben las FECHAS, para repartir las ventas por los últimos días.
 *  · Todo lo que identifica a una persona o a una empresa es ficticio. Los
 *    documentos son números obviamente falsos (00000001…).
 *  · Los comprobantes no salen a SUNAT: no hay proveedor real conectado y, aun
 *    si lo hubiera, `obtenerProveedor` fuerza el simulado para un tenant demo.
 */

export const CORREO_DEMO_POR_DEFECTO = 'pool@fer.pe'
export const correoDemo = () => (process.env.DEMO_EMAIL ?? CORREO_DEMO_POR_DEFECTO).trim().toLowerCase()

const MS_DIA = 86_400_000

interface ProductoDemo {
  name: string
  sku: string
  barcode?: string
  unitType: 'UNIDAD' | 'KILOGRAMO' | 'METRO' | 'BOLSA' | 'LITRO' | 'CAJA'
  salePrice: number
  stock: number
  minStock: number
}

/** Precios en soles, razonables para una ferretería de barrio. Los stocks bajos son a propósito. */
export const PRODUCTOS_DEMO: readonly ProductoDemo[] = [
  { name: 'Cemento Sol 42.5 kg', sku: 'CEM-SOL', barcode: '7750000100011', unitType: 'BOLSA', salePrice: 31.5, stock: 120, minStock: 30 },
  { name: 'Cemento Andino 42.5 kg', sku: 'CEM-AND', barcode: '7750000100028', unitType: 'BOLSA', salePrice: 30.9, stock: 80, minStock: 30 },
  { name: 'Fierro corrugado 3/8" x 9 m', sku: 'FIE-38', barcode: '7750000100035', unitType: 'UNIDAD', salePrice: 29.0, stock: 200, minStock: 40 },
  { name: 'Fierro corrugado 1/2" x 9 m', sku: 'FIE-12', barcode: '7750000100042', unitType: 'UNIDAD', salePrice: 52.5, stock: 90, minStock: 30 },
  { name: 'Ladrillo King Kong 18 huecos', sku: 'LAD-KK', unitType: 'UNIDAD', salePrice: 1.25, stock: 3000, minStock: 500 },
  { name: 'Arena gruesa (m³)', sku: 'ARE-GR', unitType: 'UNIDAD', salePrice: 65.0, stock: 12, minStock: 4 },
  { name: 'Clavos 3" (kg)', sku: 'CLA-3', unitType: 'KILOGRAMO', salePrice: 6.5, stock: 60, minStock: 15 },
  { name: 'Clavos 2" (kg)', sku: 'CLA-2', unitType: 'KILOGRAMO', salePrice: 6.8, stock: 40, minStock: 15 },
  { name: 'Alambre N°16 (kg)', sku: 'ALA-16', unitType: 'KILOGRAMO', salePrice: 7.9, stock: 8, minStock: 10 },
  { name: 'Tubo PVC 1/2" x 3 m', sku: 'PVC-12', barcode: '7750000100059', unitType: 'UNIDAD', salePrice: 11.8, stock: 70, minStock: 20 },
  { name: 'Tubo PVC 4" desagüe x 3 m', sku: 'PVC-4D', barcode: '7750000100066', unitType: 'UNIDAD', salePrice: 38.0, stock: 25, minStock: 8 },
  { name: 'Codo PVC 1/2"', sku: 'COD-12', unitType: 'UNIDAD', salePrice: 0.9, stock: 300, minStock: 60 },
  { name: 'Pegamento PVC 1/4 gal', sku: 'PEG-PVC', barcode: '7750000100073', unitType: 'UNIDAD', salePrice: 24.5, stock: 18, minStock: 6 },
  { name: 'Cinta teflón 1/2"', sku: 'TEF-12', barcode: '7750000100080', unitType: 'UNIDAD', salePrice: 1.5, stock: 0, minStock: 40 },
  { name: 'Cable THW 14 AWG (m)', sku: 'THW-14', unitType: 'METRO', salePrice: 2.4, stock: 600, minStock: 100 },
  { name: 'Cable THW 12 AWG (m)', sku: 'THW-12', unitType: 'METRO', salePrice: 3.6, stock: 450, minStock: 100 },
  { name: 'Interruptor simple', sku: 'INT-S', barcode: '7750000100097', unitType: 'UNIDAD', salePrice: 6.0, stock: 55, minStock: 15 },
  { name: 'Tomacorriente doble', sku: 'TOM-D', barcode: '7750000100103', unitType: 'UNIDAD', salePrice: 8.5, stock: 3, minStock: 12 },
  { name: 'Foco LED 9 W', sku: 'LED-9', barcode: '7750000100110', unitType: 'UNIDAD', salePrice: 5.5, stock: 140, minStock: 40 },
  { name: 'Cinta aislante 18 m', sku: 'CIN-AIS', barcode: '7750000100127', unitType: 'UNIDAD', salePrice: 3.5, stock: 90, minStock: 20 },
  { name: 'Pintura látex blanco 1 gal', sku: 'PIN-LB', barcode: '7750000100134', unitType: 'UNIDAD', salePrice: 48.0, stock: 36, minStock: 10 },
  { name: 'Pintura esmalte negro 1/4 gal', sku: 'PIN-EN', barcode: '7750000100141', unitType: 'UNIDAD', salePrice: 29.0, stock: 14, minStock: 8 },
  { name: 'Thinner acrílico 1 L', sku: 'THI-1', barcode: '7750000100158', unitType: 'LITRO', salePrice: 9.0, stock: 40, minStock: 12 },
  { name: 'Brocha 3"', sku: 'BRO-3', barcode: '7750000100165', unitType: 'UNIDAD', salePrice: 7.5, stock: 33, minStock: 10 },
  { name: 'Rodillo 9" con mango', sku: 'ROD-9', barcode: '7750000100172', unitType: 'UNIDAD', salePrice: 12.0, stock: 22, minStock: 8 },
  { name: 'Martillo carpintero 16 oz', sku: 'MAR-16', barcode: '7750000100189', unitType: 'UNIDAD', salePrice: 28.0, stock: 15, minStock: 5 },
  { name: 'Alicate universal 8"', sku: 'ALI-8', barcode: '7750000100196', unitType: 'UNIDAD', salePrice: 24.0, stock: 12, minStock: 5 },
  { name: 'Destornillador Phillips N°2', sku: 'DES-P2', barcode: '7750000100202', unitType: 'UNIDAD', salePrice: 9.5, stock: 4, minStock: 8 },
  { name: 'Disco de corte metal 4½"', sku: 'DIS-45', barcode: '7750000100219', unitType: 'UNIDAD', salePrice: 4.5, stock: 6, minStock: 30 },
  { name: 'Candado 40 mm', sku: 'CAN-40', barcode: '7750000100226', unitType: 'UNIDAD', salePrice: 18.0, stock: 26, minStock: 6 },
  { name: 'Bisagra 3" (par)', sku: 'BIS-3', unitType: 'UNIDAD', salePrice: 5.0, stock: 48, minStock: 12 },
  { name: 'Tornillo drywall 1" (caja 100)', sku: 'TOR-DW', barcode: '7750000100233', unitType: 'CAJA', salePrice: 8.0, stock: 0, minStock: 15 },
]

const CLIENTES_DEMO = [
  { docType: 'DNI' as const, docNumber: '00000001', name: 'Juan Pérez (cliente demo)' },
  { docType: 'DNI' as const, docNumber: '00000002', name: 'María Quispe (cliente demo)' },
  { docType: 'DNI' as const, docNumber: '00000003', name: 'Carlos Huamán (cliente demo)' },
  { docType: 'RUC' as const, docNumber: '20000000001', name: 'Constructora Los Andes S.A.C. (demo)' },
  { docType: 'RUC' as const, docNumber: '20000000002', name: 'Inversiones El Roble E.I.R.L. (demo)' },
  { docType: 'DNI' as const, docNumber: '00000004', name: 'Rosa Mamani (cliente demo)' },
]

export interface ResultadoCuentaDemo {
  tenantId: string
  userId: string
  creada: boolean
}

/**
 * Crea la cuenta demo si no existe, o la reconoce si ya existe.
 *
 * Si el correo YA pertenece a un negocio que no es de demostración, se niega:
 * convertir una cuenta real en demo la llenaría de productos y ventas
 * inventados.
 */
export async function prepararCuentaDemo(opts: {
  email: string
  password?: string
}): Promise<ResultadoCuentaDemo> {
  const email = opts.email.trim().toLowerCase()
  const existente = await prisma.user.findUnique({
    where: { email },
    select: { id: true, tenantId: true, tenant: { select: { isDemo: true } } },
  })

  if (existente) {
    if (!existente.tenantId || !existente.tenant?.isDemo) {
      throw new BusinessError(
        'FORBIDDEN_ROLE',
        `El correo ${email} ya pertenece a un negocio que NO es de demostración. ` +
          'No se toca. Usa otro correo para la demo (variable DEMO_EMAIL).',
      )
    }
    return { tenantId: existente.tenantId, userId: existente.id, creada: false }
  }

  if (!opts.password || opts.password.length < 8) {
    throw new BusinessError(
      'INVALID_DOCUMENT',
      'Para crear la cuenta demo hace falta DEMO_PASSWORD (mínimo 8 caracteres) en el entorno.',
    )
  }

  const r = await registerTenant({
    businessName: 'Ferretería Demo',
    ownerName: 'Cuenta Demo',
    email,
    password: opts.password,
    planCode: 'premium',
  })

  await prisma.$transaction([
    prisma.tenant.update({
      where: { id: r.tenantId },
      data: {
        isDemo: true,
        // La demo enseña la política de caja: el efectivo entra siempre en un turno.
        cashRequired: true,
        legalName: 'FERRETERIA DEMO S.A.C.',
        // Ficticio. Un RUC real aquí haría pasar la demo por una empresa de verdad.
        taxId: '20000000000',
        address: 'Av. Ficticia 123, Lima',
        ubigeo: '150101',
      },
    }),
    // La demo no caduca ni se bloquea por mora: es una vitrina.
    prisma.subscription.update({
      where: { tenantId: r.tenantId },
      data: { status: 'ACTIVE', trialEndsAt: null, currentPeriodEnd: null, pastDueSince: null },
    }),
  ])

  return { tenantId: r.tenantId, userId: r.userId, creada: true }
}

/** Precarga los datos de la demo (ver la cabecera del módulo). */
export async function sembrarDatosDemo(tenantId: string, ahora: Date = new Date()): Promise<{
  productos: number; clientes: number; cotizaciones: number; ventas: number; comprobantes: number
}> {
  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: tenantId }, select: { isDemo: true },
  })
  if (!tenant.isDemo) {
    throw new BusinessError('FORBIDDEN_ROLE', 'Solo se precargan datos en una cuenta de demostración.')
  }

  const owner = await prisma.user.findFirstOrThrow({
    where: { tenantId, role: 'OWNER' }, select: { id: true },
  })
  const branch = await prisma.branch.findFirstOrThrow({
    where: { tenantId, isDefault: true }, select: { id: true },
  })
  const wh = await prisma.warehouse.findFirstOrThrow({
    where: { tenantId, branchId: branch.id, isDefault: true }, select: { id: true },
  })

  const ctx: TenantContext = {
    tenantId, userId: owner.id, role: 'OWNER', access: 'FULL',
    branchId: branch.id, branchIds: [branch.id],
  }
  const db = getTenantPrisma(ctx)

  // ── Clientes ───────────────────────────────────────────────────────────
  await prisma.customer.createMany({
    data: CLIENTES_DEMO.map((c) => ({ tenantId, ...c })),
    skipDuplicates: true,
  })
  const clientes = await prisma.customer.findMany({ where: { tenantId }, select: { id: true, docNumber: true } })
  const cliente = (n: string) => clientes.find((c) => c.docNumber === n)?.id ?? null

  // ── Productos con stock, por el servicio del alta exprés ───────────────
  const ids = new Map<string, string>()
  const yaHechos = await prisma.product.findMany({
    where: { tenantId, sku: { in: PRODUCTOS_DEMO.map((p) => p.sku) } }, select: { id: true, sku: true },
  })
  for (const p of yaHechos) ids.set(p.sku, p.id)
  const pendientes = PRODUCTOS_DEMO.filter((p) => !ids.has(p.sku))
  // En tandas de 8: son independientes y la red es lo que más tarda.
  for (let i = 0; i < pendientes.length; i += 8) {
    await Promise.all(pendientes.slice(i, i + 8).map(async (p) => {
      const r = await createProductExpress(db, ctx, {
        name: p.name, sku: p.sku, barcode: p.barcode, unitType: p.unitType,
        salePrice: p.salePrice, initialStock: p.stock, minStock: p.minStock,
        warehouseId: wh.id, idempotencyKey: randomUUID(),
      } as never)
      ids.set(p.sku, r.productId)
    }))
  }
  const prod = (sku: string) => ids.get(sku)!

  const linea = (sku: string, quantity: number) => ({ productId: prod(sku), quantity, discount: 0 })
  const fechar = async (saleId: string, cuando: Date) => {
    await prisma.sale.update({ where: { id: saleId }, data: { createdAt: cuando, completedAt: cuando } })
    await prisma.payment.updateMany({ where: { saleId }, data: { createdAt: cuando } })
    await prisma.stockMovement.updateMany({ where: { tenantId, referenceId: saleId }, data: { createdAt: cuando } })
    await prisma.taxDocument.updateMany({ where: { saleId }, data: { issuedAt: cuando } })
  }
  const hace = (dias: number, hora: number) => {
    const d = new Date(ahora.getTime() - dias * MS_DIA)
    d.setUTCHours(hora + 5, 0, 0, 0) // hora de Lima → UTC
    return d > ahora ? new Date(ahora.getTime() - 3_600_000) : d
  }

  // Si una ejecución anterior se cortó a medias, los productos y clientes ya
  // están; lo transaccional (ventas, caja, cotizaciones) solo se hace sobre una
  // demo SIN ventas, para no duplicar nada ni dejar números repetidos.
  if ((await prisma.sale.count({ where: { tenantId } })) > 0) {
    return { productos: PRODUCTOS_DEMO.length, clientes: CLIENTES_DEMO.length, cotizaciones: 0, ventas: 0, comprobantes: 0 }
  }

  // ── Turno de ayer, cerrado con un pequeño faltante ─────────────────────
  await openCashSession(db, ctx, { openingAmount: 100, notes: 'Apertura (demo)' } as never)
  const ventasDef: { dias: number; hora: number; cliente?: string; doc: 'NOTA_VENTA' | 'BOLETA' | 'FACTURA'; metodo: 'EFECTIVO' | 'YAPE' | 'TARJETA_DEBITO' | 'TRANSFERENCIA'; items: [string, number][] }[] = [
    { dias: 6, hora: 9, doc: 'BOLETA', metodo: 'EFECTIVO', items: [['CEM-SOL', 10], ['CLA-3', 2]] },
    { dias: 6, hora: 15, cliente: '20000000001', doc: 'FACTURA', metodo: 'TRANSFERENCIA', items: [['FIE-38', 40], ['FIE-12', 20], ['CEM-AND', 30]] },
    { dias: 5, hora: 10, doc: 'NOTA_VENTA', metodo: 'EFECTIVO', items: [['PVC-12', 4], ['COD-12', 8], ['PEG-PVC', 1]] },
    { dias: 4, hora: 11, cliente: '00000001', doc: 'BOLETA', metodo: 'YAPE', items: [['PIN-LB', 2], ['BRO-3', 2], ['ROD-9', 1]] },
    { dias: 4, hora: 17, doc: 'BOLETA', metodo: 'EFECTIVO', items: [['THW-14', 50], ['INT-S', 3], ['CIN-AIS', 2]] },
    { dias: 3, hora: 9, cliente: '00000002', doc: 'BOLETA', metodo: 'TARJETA_DEBITO', items: [['MAR-16', 1], ['ALI-8', 1], ['DES-P2', 2]] },
    { dias: 3, hora: 14, doc: 'NOTA_VENTA', metodo: 'EFECTIVO', items: [['LAD-KK', 400], ['ARE-GR', 2]] },
    { dias: 2, hora: 10, cliente: '20000000002', doc: 'FACTURA', metodo: 'TRANSFERENCIA', items: [['CEM-SOL', 25], ['FIE-38', 30]] },
    { dias: 2, hora: 16, doc: 'BOLETA', metodo: 'YAPE', items: [['LED-9', 6], ['TOM-D', 2]] },
    { dias: 1, hora: 9, doc: 'NOTA_VENTA', metodo: 'EFECTIVO', items: [['CLA-2', 3], ['ALA-16', 2], ['BIS-3', 2]] },
    { dias: 1, hora: 13, cliente: '00000003', doc: 'BOLETA', metodo: 'EFECTIVO', items: [['DIS-45', 4], ['CAN-40', 2]] },
    { dias: 1, hora: 18, doc: 'BOLETA', metodo: 'TARJETA_DEBITO', items: [['PIN-EN', 2], ['THI-1', 2]] },
    { dias: 0, hora: 8, doc: 'BOLETA', metodo: 'EFECTIVO', items: [['CEM-AND', 8], ['PVC-4D', 3]] },
    { dias: 0, hora: 10, cliente: '00000004', doc: 'NOTA_VENTA', metodo: 'YAPE', items: [['THW-12', 30], ['CIN-AIS', 1]] },
  ]

  let ventas = 0
  let comprobantes = 0
  let turnoHoyAbierto = false
  for (const v of ventasDef) {
    // Al pasar de "ayer" a "hoy": se cierra el turno viejo y se abre el de hoy.
    if (v.dias === 0 && !turnoHoyAbierto) {
      const actual = await currentCashSession(db, ctx)
      if (!actual) throw new Error('La demo esperaba un turno abierto.')
      // Cierra con un faltante de S/ 2.50: así el panel enseña un descuadre real.
      await closeCashSession(db, ctx, {
        sessionId: actual.id,
        countedAmount: Math.max(0, Math.round((actual.expectedAmount - 2.5) * 100) / 100),
        notes: 'Cierre (demo)',
      } as never)
      await openCashSession(db, ctx, { openingAmount: 150, notes: 'Apertura de hoy (demo)' } as never)
      turnoHoyAbierto = true
    }
    const items = v.items.map(([sku, q]) => linea(sku, q))
    const total = v.items.reduce((s, [sku, q]) => s + PRODUCTOS_DEMO.find((p) => p.sku === sku)!.salePrice * q, 0)
    const r = await registerSale(db, ctx, {
      warehouseId: wh.id,
      customerId: v.cliente ? cliente(v.cliente) : null,
      items,
      payments: [{ method: v.metodo, amount: Math.round(total * 100) / 100 }],
      documentType: v.doc === 'NOTA_VENTA' ? 'NOTA_VENTA' : v.doc,
      allowNegativeStock: false,
      idempotencyKey: randomUUID(),
    } as never)
    ventas++
    if (v.doc !== 'NOTA_VENTA') {
      await issueTaxDocument(db, ctx, { saleId: r.saleId, documentType: v.doc } as never)
      comprobantes++
    }
    await fechar(r.saleId, hace(v.dias, v.hora))
  }

  // El turno cerrado queda con fechas de ayer; el abierto, con las de hoy.
  const ayer = hace(1, 8)
  await prisma.cashSession.updateMany({
    where: { tenantId, status: 'CERRADA' },
    data: { openedAt: ayer, closedAt: hace(1, 20) },
  })
  await prisma.cashSession.updateMany({
    where: { tenantId, status: 'ABIERTA' },
    data: { openedAt: hace(0, 7) },
  })

  // ── Cotizaciones ───────────────────────────────────────────────────────
  const cotis: [string | undefined, [string, number][]][] = [
    ['20000000001', [['CEM-SOL', 40], ['FIE-12', 60], ['LAD-KK', 2000]]],
    ['00000002', [['PIN-LB', 4], ['THI-1', 4], ['BRO-3', 4]]],
    [undefined, [['PVC-4D', 10], ['PEG-PVC', 3]]],
    ['20000000002', [['THW-14', 300], ['THW-12', 200], ['INT-S', 20], ['TOM-D', 20]]],
  ]
  let cotizaciones = 0
  for (const [doc, its] of cotis) {
    await registerQuote(db, ctx, {
      warehouseId: wh.id,
      customerId: doc ? cliente(doc) : null,
      items: its.map(([sku, q]) => linea(sku, q)),
      validDays: 15,
      idempotencyKey: randomUUID(),
    } as never)
    cotizaciones++
  }
  // Una cotización convertida en venta, para ver el flujo completo.
  const q = await db.quote.findFirstOrThrow({ orderBy: { createdAt: 'asc' }, select: { id: true, total: true } })
  const conv = await convertQuoteToSale(db, ctx, {
    quoteId: q.id, payments: [{ method: 'TRANSFERENCIA', amount: Number(q.total) }],
    documentType: 'FACTURA', allowNegativeStock: false, idempotencyKey: randomUUID(),
  } as never)
  ventas++
  await fechar(conv.saleId, hace(0, 9))

  return { productos: PRODUCTOS_DEMO.length, clientes: CLIENTES_DEMO.length, cotizaciones, ventas, comprobantes }
}

/** Un reclamo de sembrado caduca a los 10 minutos: si el proceso murió, otro lo retoma. */
export const CADUCIDAD_RECLAMO_MS = 10 * 60_000
const VENTAS_ESPERADAS = 15

/**
 * Garantiza que la demo tenga sus datos. Seguro de llamar muchas veces y a la
 * vez: `demoSeededAt` es el RECLAMO (la hora del último intento) y se toma con
 * un UPDATE condicional, así que de varios llamadores simultáneos solo uno
 * siembra. Si ese proceso muere (una función serverless cortada por tiempo),
 * el reclamo caduca y el siguiente lo retoma; como el sembrado es reanudable,
 * retomarlo no duplica nada. Si la demo ya está completa, no hace nada.
 */
export async function asegurarDatosDemo(
  tenantId: string,
  ahora: Date = new Date(),
): Promise<'sembrada' | 'ya-estaba' | 'no-es-demo'> {
  const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { isDemo: true } })
  if (!t?.isDemo) return 'no-es-demo'

  const reclamo = await prisma.tenant.updateMany({
    where: {
      id: tenantId, isDemo: true,
      OR: [{ demoSeededAt: null }, { demoSeededAt: { lt: new Date(ahora.getTime() - CADUCIDAD_RECLAMO_MS) } }],
    },
    data: { demoSeededAt: ahora },
  })
  if (reclamo.count !== 1) return 'ya-estaba'

  const [productos, ventas] = await Promise.all([
    prisma.product.count({ where: { tenantId, deletedAt: null } }),
    prisma.sale.count({ where: { tenantId, status: 'COMPLETADA' } }),
  ])
  if (productos >= PRODUCTOS_DEMO.length && ventas >= VENTAS_ESPERADAS) return 'ya-estaba'

  await sembrarDatosDemo(tenantId, ahora)
  return 'sembrada'
}
