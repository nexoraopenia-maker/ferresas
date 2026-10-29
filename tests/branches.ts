import './guard'
import { correr } from './teardown'
import { randomUUID } from 'node:crypto'
import { abrirTurno, crearSucursal, asignarSucursal } from './fixtures'
import { prisma } from '@/lib/prisma'
import { completarRuc } from '../src/lib/documentos'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { serieDeSucursal, siguienteSeriesNumber, scopeTributario } from '@/features/branches/series'
import { resolverSucursalActiva } from '@/lib/branch-selection'
import {
  avisoEstablecimiento, esCasaMatriz, verificarEstablecimiento,
} from '@/features/branches/establecimiento'
import { createBranch, updateBranch, deleteBranch, assignBranches } from '@/features/branches/branch-service'
import { createBranchSchema, deleteBranchSchema, assignBranchesSchema, updateBranchSchema } from '@/features/branches/schemas'
import { openCashSession, closeCashSession, currentCashSession } from '@/features/branches/cash-service'
import { puede } from '@/lib/puede'
import { openCashSchema, closeCashSchema } from '@/features/branches/cash-schemas'
import {
  createTransfer, approveTransfer, shipTransfer, receiveTransfer, rejectTransfer,
} from '@/features/branches/transfer-service'
import {
  createTransferSchema, receiveTransferSchema, rejectTransferSchema,
} from '@/features/branches/transfer-schemas'
import { registerSale } from '@/features/pos/sale-service'
import { registerSaleSchema } from '@/features/pos/schemas'
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
const code = async (fn: () => Promise<unknown>) =>
  fn().then(() => 'SIN_ERROR').catch((e) => (e as { code?: string }).code ?? `ERR:${(e as Error).message}`)

async function main() {
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n1) Series por sucursal (función pura)')
  check('sucursal 1 → serie 001 con prefijo V (como ANTES de multi-sucursal)',
    JSON.stringify(serieDeSucursal('SALE', 1)) === JSON.stringify({ series: '001', prefix: 'V' }))
  check('>>> retrocompatible: boleta de la sucursal 1 sigue siendo B001',
    serieDeSucursal('TAX_BOLETA', 1).series === 'B001')
  check('y factura F001', serieDeSucursal('TAX_FACTURA', 1).series === 'F001')
  check('sucursal 2 → B002, no B001', serieDeSucursal('TAX_BOLETA', 2).series === 'B002')
  check('sucursal 2 venta → serie 002', serieDeSucursal('SALE', 2).series === '002')
  check('sucursal 47 rellena a 3 dígitos', serieDeSucursal('SALE', 47).series === '047')
  check('sucursal 999 es el máximo', serieDeSucursal('SALE', 999).series === '999')
  check('cotización lleva prefijo C', serieDeSucursal('QUOTE', 1).prefix === 'C')
  check('transferencia lleva prefijo T', serieDeSucursal('TRANSFER', 1).prefix === 'T')
  check('serie 0 se rechaza', await code(async () => serieDeSucursal('SALE', 0)) === 'INVALID_DOCUMENT')
  check('serie 1000 se rechaza', await code(async () => serieDeSucursal('SALE', 1000)) === 'INVALID_DOCUMENT')
  check('serie decimal se rechaza', await code(async () => serieDeSucursal('SALE', 1.5)) === 'INVALID_DOCUMENT')
  check('scope tributario de boleta', scopeTributario('BOLETA') === 'TAX_BOLETA')

  console.log('\n   Asignación del siguiente número de serie')
  check('el primero es 1', siguienteSeriesNumber([]) === 1)
  check('tras 1 y 2 viene el 3', siguienteSeriesNumber([1, 2]) === 3)
  check('>>> reutiliza el hueco que dejó una baja', siguienteSeriesNumber([1, 3]) === 2)
  check('no se marea con el desorden', siguienteSeriesNumber([3, 1, 2]) === 4)

  console.log('\n1b) Código de establecimiento: aviso de NO verificado')
  check('la casa matriz (0000) NO lleva aviso: siempre es correcta',
    avisoEstablecimiento('0000') === null)
  check('>>> un anexo SÍ avisa de que no se puede verificar contra el RUC',
    (avisoEstablecimiento('0001') ?? '').includes('Clave SOL'))
  check('esCasaMatriz solo con 0000',
    esCasaMatriz('0000') && !esCasaMatriz('0001'))
  check('la casa matriz se reporta VERIFICADA sin consultar nada',
    (await verificarEstablecimiento('20123456789', '0000')).estado === 'VERIFICADO')
  check('>>> un anexo queda SIN_VERIFICAR, no se finge comprobado',
    (await verificarEstablecimiento('20123456789', '0001')).estado === 'SIN_VERIFICAR')
  check('sin RUC declarado, pide el RUC antes',
    (await verificarEstablecimiento(null, '0001')).mensaje.includes('RUC'))

  console.log('\n2) Elección de sucursal activa (función pura)')
  const S = (id: string, isDefault = false, c = id) => ({ id, isDefault, code: c })
  check('sin sucursales asignadas → undefined',
    resolverSucursalActiva([]) === undefined)
  check('con una sola, esa', resolverSucursalActiva([S('a')]) === 'a')
  check('respeta la pedida por cookie si es suya',
    resolverSucursalActiva([S('a'), S('b')], 'b') === 'b')
  check('>>> IGNORA la pedida si NO es suya (no se opera el local ajeno)',
    resolverSucursalActiva([S('a'), S('b')], 'ajena') !== 'ajena')
  check('y cae en la marcada por defecto',
    resolverSucursalActiva([S('a'), S('b', true)], 'ajena') === 'b')
  check('sin defecto, la primera por código (resultado ESTABLE entre pestañas)',
    resolverSucursalActiva([S('z', false, 'ZZZ'), S('a', false, 'AAA')]) === 'a')

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n3) Fixtures')
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'premium' } })
  const t = await prisma.tenant.create({
    data: {
      slug: `suc-${M}`, name: `Ferretería Multi ${M}`, planId: plan.id,
      legalName: `MULTI ${M} S.A.C.`, taxId: completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`),
      realBillingEnabledAt: new Date(),
    },
  })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, status: 'ACTIVE' } })
  const owner = await prisma.user.create({
    data: { email: `o-${M}@x.com`, name: 'Dueña', role: 'OWNER', tenantId: t.id },
  })
  const matriz = await crearSucursal(t.id)
  await asignarSucursal(t.id, owner.id, matriz.id)
  const wMatriz = await prisma.warehouse.create({
    data: { tenantId: t.id, branchId: matriz.id, code: 'PRIN', name: 'Tienda', isDefault: true },
  })
  const ctx: TenantContext = {
    tenantId: t.id, userId: owner.id, role: 'OWNER', access: 'FULL', branchId: matriz.id,
  }
  const db = getTenantPrisma(ctx)
  check('casa matriz creada con serie 1', matriz.seriesNumber === 1)

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n4) Alta de sucursal')
  const suc2 = await createBranch(db, ctx, createBranchSchema.parse({
    code: 'SJL', name: 'San Juan de Lurigancho',
    establishmentCode: '0001', ubigeo: '150132', address: 'Av. Próceres 123',
  }))
  check('se le asigna el siguiente número de serie', suc2.seriesNumber === 2, String(suc2.seriesNumber))
  check('crea su almacén automáticamente', suc2.warehouseId !== null)
  check('código de establecimiento SUNAT guardado', suc2.establishmentCode === '0001')
  check('queda auditada',
    (await db.auditLog.count({ where: { action: 'branch.create', entityId: suc2.id } })) === 1)

  check('>>> código de establecimiento duplicado se rechaza',
    await code(() => createBranch(db, ctx, createBranchSchema.parse({
      code: 'OTRA', name: 'Otra', establishmentCode: '0001',
    }))) === 'DUPLICATE_CODE')
  check('>>> código interno duplicado se rechaza',
    await code(() => createBranch(db, ctx, createBranchSchema.parse({
      code: 'SJL', name: 'Repe', establishmentCode: '0009',
    }))) === 'DUPLICATE_CODE')
  check('>>> número de serie ya usado se rechaza',
    await code(() => createBranch(db, ctx, createBranchSchema.parse({
      code: 'TRES', name: 'Tres', establishmentCode: '0003', seriesNumber: 2,
    }))) === 'DUPLICATE_CODE')
  check('ubigeo de 5 dígitos no pasa el esquema',
    !createBranchSchema.safeParse({ code: 'X1', name: 'X', establishmentCode: '0004', ubigeo: '15013' }).success)
  check('establecimiento de 3 dígitos no pasa el esquema',
    !createBranchSchema.safeParse({ code: 'X2', name: 'X', establishmentCode: '001' }).success)
  check('un VENDEDOR no puede crear sucursales',
    await code(() => createBranch(getTenantPrisma({ ...ctx, role: 'VENDEDOR' }), { ...ctx, role: 'VENDEDOR' },
      createBranchSchema.parse({ code: 'NOPE', name: 'No', establishmentCode: '0008' }))) === 'FORBIDDEN_ROLE')

  console.log('\n   Lo que NO se puede cambiar')
  check('el esquema de edición no admite seriesNumber',
    !('seriesNumber' in (updateBranchSchema.parse({ branchId: suc2.id, seriesNumber: 9 } as never) as object)))
  check('ni establishmentCode',
    !('establishmentCode' in (updateBranchSchema.parse({ branchId: suc2.id, establishmentCode: '0009' } as never) as object)))
  await updateBranch(db, ctx, updateBranchSchema.parse({ branchId: suc2.id, name: 'SJL Centro' }))
  check('el nombre sí se edita',
    (await db.branch.findFirstOrThrow({ where: { id: suc2.id } })).name === 'SJL Centro')
  check('la casa matriz no se puede desactivar',
    await code(() => updateBranch(db, ctx, updateBranchSchema.parse({
      branchId: matriz.id, isActive: false,
    }))) === 'INVALID_DOCUMENT')

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n5) CORRELATIVOS INDEPENDIENTES POR SUCURSAL')
  const prod = await createProductExpress(db, ctx, createProductExpressSchema.parse({
    barcode: `771${M}01`, name: 'Cemento Sol 42.5 kg', salePrice: 32.9,
    initialStock: 500, minStock: 20, warehouseId: wMatriz.id,
  }))

  // F6.8b: una persona tiene un solo turno abierto y cobra con el suyo: la sucursal 2 la lleva otro dueño.
  const dueno2 = await prisma.user.create({ data: { tenantId: t.id, email: `dueno2-${M}@x.com`, name: 'Dueño 2', role: 'OWNER' } })
  const ctx2: TenantContext = { ...ctx, userId: dueno2.id, branchId: suc2.id }
  const turnoM = await abrirTurno(t.id, ctx.userId, ctx.branchId!), turnoS = await abrirTurno(t.id, dueno2.id, suc2.id)
  const db2 = getTenantPrisma(ctx2)
  // `createBranch` ya asignó la sucursal a quien la creó: no hace falta
  // asignarla otra vez (y la PK compuesta lo rechazaría).
  const w2 = suc2.warehouseId!
  await createProductExpress(db2, ctx2, createProductExpressSchema.parse({
    barcode: `771${M}02`, name: 'Fierro 1/2"', salePrice: 25,
    initialStock: 300, minStock: 10, warehouseId: w2,
  }))

  const v1 = await registerSale(db, ctx, registerSaleSchema.parse({
    warehouseId: wMatriz.id, items: [{ productId: prod.productId, quantity: 1 }],
    payments: [{ method: 'EFECTIVO', amount: 32.9 }],
  }))
  const v2 = await registerSale(db2, ctx2, registerSaleSchema.parse({
    warehouseId: w2, items: [{ productId: (await db2.product.findFirstOrThrow({ where: { barcode: `771${M}02` } })).id, quantity: 1 }],
    payments: [{ method: 'EFECTIVO', amount: 25 }],
  }))
  check('matriz emite con serie 001', v1.number.startsWith('V001-'), v1.number)
  check('>>> SJL emite con serie 002, NO 001', v2.number.startsWith('V002-'), v2.number)
  check('ambas arrancan en el correlativo 1 de SU serie',
    v1.number.endsWith('00000001') && v2.number.endsWith('00000001'))

  const b1 = await issueTaxDocument(db, ctx, { saleId: v1.saleId, documentType: 'BOLETA' })
  const b2 = await issueTaxDocument(db2, ctx2, { saleId: v2.saleId, documentType: 'BOLETA' })
  check('boleta de matriz es B001-00000001', b1.fullNumber === 'B001-00000001', b1.fullNumber)
  check('>>> boleta de SJL es B002-00000001: sin colisión bajo el mismo RUC',
    b2.fullNumber === 'B002-00000001', b2.fullNumber)

  console.log('\n   La serie la manda la sucursal DE LA VENTA, no la del usuario')
  const v3 = await registerSale(db2, ctx2, registerSaleSchema.parse({
    warehouseId: w2, items: [{ productId: (await db2.product.findFirstOrThrow({ where: { barcode: `771${M}02` } })).id, quantity: 1 }],
    payments: [{ method: 'EFECTIVO', amount: 25 }],
  }))
  // Un usuario POSICIONADO en matriz emite el comprobante de una venta de SJL.
  const b3 = await issueTaxDocument(db, ctx, { saleId: v3.saleId, documentType: 'BOLETA' })
  check('>>> usa B002 (la del local que vendió), no B001 (la del usuario)',
    b3.fullNumber === 'B002-00000002', b3.fullNumber)
  const prodSJL = await db2.product.findFirstOrThrow({ where: { barcode: `771${M}02` } })
  const v4 = await registerSale(db2, ctx2, registerSaleSchema.parse({
    warehouseId: w2, items: [{ productId: prodSJL.id, quantity: 1 }],
    payments: [{ method: 'EFECTIVO', amount: 25 }],
  }))
  check('una serie explícita que no corresponde se RECHAZA, no se ignora',
    await code(() => issueTaxDocument(db, ctx, {
      saleId: v4.saleId, documentType: 'BOLETA', series: 'B001',
    })) === 'INVALID_DOCUMENT')

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n6) AISLAMIENTO ENTRE SUCURSALES del mismo tenant')
  check('>>> no se puede vender del almacén de OTRA sucursal',
    await code(() => registerSale(db, ctx, registerSaleSchema.parse({
      warehouseId: w2, // almacén de SJL, usuario posicionado en matriz
      items: [{ productId: prod.productId, quantity: 1 }],
      payments: [{ method: 'EFECTIVO', amount: 32.9 }],
    }))) === 'TENANT_MISMATCH')
  check('sin sucursal asignada no se puede vender',
    await code(() => registerSale(
      getTenantPrisma({ ...ctx, branchId: undefined }), { ...ctx, branchId: undefined },
      registerSaleSchema.parse({
        warehouseId: wMatriz.id, items: [{ productId: prod.productId, quantity: 1 }],
        payments: [{ method: 'EFECTIVO', amount: 32.9 }],
      }))) === 'FORBIDDEN_ROLE')

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n7) TURNO DE CAJA y arqueo')
  // Los turnos que sirvieron para vender arriba se cierran: el arqueo de esta sección parte de cero.
  await closeCashSession(db, ctx, closeCashSchema.parse({ sessionId: turnoM, countedAmount: 0 }))
  await closeCashSession(db2, ctx2, closeCashSchema.parse({ sessionId: turnoS, countedAmount: 0 }))
  const caja = await openCashSession(db, ctx, openCashSchema.parse({ openingAmount: 100 }))
  check('abre con fondo de 100', caja.openingAmount === 100 && caja.status === 'ABIERTA')
  check('>>> no se puede abrir una SEGUNDA caja en la misma sucursal',
    await code(() => openCashSession(db, ctx, openCashSchema.parse({ openingAmount: 50 }))) === 'DUPLICATE_CODE')
  // F6.8: una persona tiene como mucho UN turno abierto en toda la cuenta, así que la caja de la otra sucursal la abre otra persona.
  check('otra sucursal SÍ puede tener su propia caja abierta (la abre otra persona)',
    (await openCashSession(db2, ctx2, openCashSchema.parse({ openingAmount: 200 }))).status === 'ABIERTA')

  // Venta en efectivo: entra al cajón, con vuelto.
  const vCaja = await registerSale(db, ctx, registerSaleSchema.parse({
    warehouseId: wMatriz.id, items: [{ productId: prod.productId, quantity: 2 }],
    payments: [{ method: 'EFECTIVO', amount: 100, change: 34.2 }],
  }))
  check('la venta se engancha al turno abierto',
    (await db.sale.findFirstOrThrow({ where: { id: vCaja.saleId }, select: { cashSessionId: true } }))
      .cashSessionId === caja.id)

  // Venta con Yape: NO pone dinero en el cajón.
  await registerSale(db, ctx, registerSaleSchema.parse({
    warehouseId: wMatriz.id, items: [{ productId: prod.productId, quantity: 1 }],
    payments: [{ method: 'YAPE', amount: 32.9 }],
  }))

  const enCurso = await currentCashSession(db, ctx)
  check('el esperado en curso: 100 + 100 efectivo - 34.20 vuelto = 165.80',
    enCurso?.expectedAmount === 165.8, String(enCurso?.expectedAmount))
  check('>>> la venta por Yape NO cuenta como efectivo en el cajón',
    enCurso?.expectedAmount === 165.8 && enCurso?.salesCount === 2,
    `esperado ${enCurso?.expectedAmount}, ventas ${enCurso?.salesCount}`)

  const cierre = await closeCashSession(db, ctx, closeCashSchema.parse({
    sessionId: caja.id, countedAmount: 160, notes: 'Faltan 5.80',
  }))
  check('arqueo: esperado 165.80', cierre.expectedAmount === 165.8, String(cierre.expectedAmount))
  check('>>> descuadre negativo = FALTANTE de 5.80', cierre.difference === -5.8, String(cierre.difference))
  check('cuenta 2 ventas en el turno', cierre.salesCount === 2, String(cierre.salesCount))
  check('el total vendido incluye Yape (98.70)', cierre.salesTotal === 98.7, String(cierre.salesTotal))
  check('pero el efectivo del cajón solo 100', cierre.cashTotal === 100, String(cierre.cashTotal))
  check('el descuadre queda auditado',
    (await db.auditLog.count({ where: { action: 'cash.close.descuadre', entityId: caja.id } })) === 1)
  check('un turno cerrado no se cierra dos veces',
    await code(() => closeCashSession(db, ctx, closeCashSchema.parse({
      sessionId: caja.id, countedAmount: 160,
    }))) === 'INVALID_DOCUMENT')
  check('tras cerrar, ya se puede abrir otro turno',
    (await openCashSession(db, ctx, openCashSchema.parse({ openingAmount: 0 }))).status === 'ABIERTA')
  check('el arqueo quedó CONGELADO en la fila',
    Number((await db.cashSession.findFirstOrThrow({ where: { id: caja.id } })).difference) === -5.8)

  console.log('\n   >>> Cerrar el turno de OTRO: un poder = un permiso')
  /*
   * El caso que motivó `caja.cerrar_ajeno`. Antes se exigía la INTERSECCIÓN
   * de `caja.abrir_cerrar` y `caja.arqueo`, y con usuarios de varios roles los
   * permisos se UNEN: un CAJERO + CONTADOR cumple las dos sin que ninguno de
   * sus roles quisiera ese poder, y cierra el cajón del compañero.
   */
  const turnoAjeno = await currentCashSession(db, ctx) // abierto por el DUEÑO
  const multi = await prisma.user.create({
    data: { email: `cc-${M}@x.com`, name: 'Cajero y contador', role: 'CAJERO', tenantId: t.id },
  })
  await asignarSucursal(t.id, multi.id, matriz.id)
  const ctxMulti: TenantContext = {
    tenantId: t.id, userId: multi.id, role: 'CAJERO', roles: ['CONTADOR'],
    access: 'FULL', branchId: matriz.id,
  }
  const dbMulti = getTenantPrisma(ctxMulti)
  check('el turno lo abrió OTRA persona', turnoAjeno !== null)
  check('>>> CAJERO + CONTADOR tiene los dos permisos de la antigua intersección',
    puede(ctxMulti, 'caja.abrir_cerrar') && puede(ctxMulti, 'caja.arqueo'))
  check('>>> y es RECHAZADO al intentar cerrar el cajón ajeno',
    await code(() => closeCashSession(dbMulti, ctxMulti, closeCashSchema.parse({
      sessionId: turnoAjeno!.id, countedAmount: 0,
    }))) === 'FORBIDDEN_ROLE')
  check('el turno sigue ABIERTO tras el intento',
    (await db.cashSession.findFirstOrThrow({ where: { id: turnoAjeno!.id } })).status === 'ABIERTA')
  check('un VENDEDOR tampoco', await code(() => closeCashSession(
    getTenantPrisma({ ...ctx, userId: multi.id, role: 'VENDEDOR' }),
    { ...ctx, userId: multi.id, role: 'VENDEDOR' },
    closeCashSchema.parse({ sessionId: turnoAjeno!.id, countedAmount: 0 }),
  )) === 'FORBIDDEN_ROLE')
  const ctxAdmin: TenantContext = { ...ctx, userId: multi.id, role: 'ADMIN' }
  check('>>> un ADMIN SÍ puede cerrar el turno de otro',
    (await closeCashSession(getTenantPrisma(ctxAdmin), ctxAdmin, closeCashSchema.parse({
      sessionId: turnoAjeno!.id, countedAmount: 0, notes: 'Cierre por supervisión',
    }))).status === 'CERRADA')
  await openCashSession(db, ctx, openCashSchema.parse({ openingAmount: 0 })) // se restituye el turno

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n8) TRANSFERENCIAS entre sucursales')
  const stockAntes = Number((await db.stock.findFirstOrThrow({
    where: { productId: prod.productId, warehouseId: wMatriz.id },
  })).quantity)

  const prod2 = await createProductExpress(db, ctx, createProductExpressSchema.parse({
    barcode: `771${M}03`, name: 'Clavo 3" (kg)', salePrice: 6.5,
    initialStock: 80, minStock: 5, warehouseId: wMatriz.id, unitType: 'KILOGRAMO',
  }))
  const tr = await createTransfer(db, ctx, createTransferSchema.parse({
    fromWarehouseId: wMatriz.id, toBranchId: suc2.id, toWarehouseId: w2,
    items: [
      { productId: prod.productId, quantity: 50 },
      { productId: prod2.productId, quantity: 12.5 },
    ],
  }))
  check('nace SOLICITADA', tr.status === 'SOLICITADA')
  check('lleva serie de la sucursal origen', tr.number.startsWith('T001-'), tr.number)
  check('>>> solicitar NO mueve stock todavía',
    Number((await db.stock.findFirstOrThrow({
      where: { productId: prod.productId, warehouseId: wMatriz.id },
    })).quantity) === stockAntes)
  check('no se puede transferir a la MISMA sucursal',
    await code(() => createTransfer(db, ctx, createTransferSchema.parse({
      fromWarehouseId: wMatriz.id, toBranchId: matriz.id, toWarehouseId: wMatriz.id,
      items: [{ productId: prod.productId, quantity: 1 }],
    }))) === 'INVALID_DOCUMENT')
  check('no se puede despachar sin aprobar',
    await code(() => shipTransfer(db, ctx, { transferId: tr.id })) === 'INVALID_DOCUMENT')

  const ctxAprueba: TenantContext = { ...ctx, userId: multi.id, role: 'ADMIN' }
  const dbAprueba = getTenantPrisma(ctxAprueba)
  check('>>> quien solicita NO puede aprobar su propia transferencia (ni siendo OWNER)',
    await code(() => approveTransfer(db, ctx, { transferId: tr.id })) === 'FORBIDDEN_ROLE')
  check('sigue SOLICITADA tras el intento', (await db.branchTransfer.findFirstOrThrow({ where: { id: tr.id } })).status === 'SOLICITADA')
  await approveTransfer(dbAprueba, ctxAprueba, { transferId: tr.id })
  check('aprobada tampoco mueve stock',
    Number((await db.stock.findFirstOrThrow({
      where: { productId: prod.productId, warehouseId: wMatriz.id },
    })).quantity) === stockAntes)

  await shipTransfer(db, ctx, { transferId: tr.id })
  const stockTransito = Number((await db.stock.findFirstOrThrow({
    where: { productId: prod.productId, warehouseId: wMatriz.id },
  })).quantity)
  check('>>> al despachar, el stock SALE del origen', stockTransito === stockAntes - 50,
    `${stockAntes} → ${stockTransito}`)
  check('el movimiento se etiqueta TRANSFERENCIA_SALIDA en el kardex',
    (await db.stockMovement.findFirst({
      where: { productId: prod.productId, type: 'TRANSFERENCIA_SALIDA' },
      orderBy: { createdAt: 'desc' },
    })) !== null)
  check('el destino TODAVÍA no lo tiene (va en la camioneta)',
    (await db.stock.findFirst({ where: { productId: prod.productId, warehouseId: w2 } })) === null)
  check('no se despacha dos veces',
    await code(() => shipTransfer(db, ctx, { transferId: tr.id })) === 'INVALID_DOCUMENT')

  const items = await db.branchTransferItem.findMany({
    where: { transferId: tr.id }, orderBy: { skuSnapshot: 'asc' }, select: { id: true, productId: true },
  })
  const itCemento = items.find((i) => i.productId === prod.productId)!
  const itClavo = items.find((i) => i.productId === prod2.productId)!

  check('el esquema rechaza una lista de conteo VACÍA',
    !receiveTransferSchema.safeParse({ transferId: tr.id, items: [] }).success)
  check('>>> el servicio rechaza un conteo INCOMPLETO (falta declarar una línea)',
    await code(() => receiveTransfer(db2, ctx2, receiveTransferSchema.parse({
      transferId: tr.id, items: [{ itemId: itCemento.id, quantityReceived: 50 }],
    }))) === 'INVALID_DOCUMENT')
  check('>>> no puede llegar MÁS de lo que salió',
    await code(() => receiveTransfer(db2, ctx2, receiveTransferSchema.parse({
      transferId: tr.id,
      items: [
        { itemId: itCemento.id, quantityReceived: 60 },
        { itemId: itClavo.id, quantityReceived: 12.5 },
      ],
    }))) === 'INVALID_DOCUMENT')

  const rec = await receiveTransfer(db2, ctx2, receiveTransferSchema.parse({
    transferId: tr.id,
    items: [
      { itemId: itCemento.id, quantityReceived: 48 },
      // Granel: llega el peso exacto despachado, con decimales.
      { itemId: itClavo.id, quantityReceived: 12.5 },
    ],
  }))
  check('recibida con 1 línea con faltante', rec.faltantes === 1, String(rec.faltantes))
  check('la línea a granel llega completa con sus decimales',
    Number((await db.stock.findFirstOrThrow({
      where: { productId: prod2.productId, warehouseId: w2 },
    })).quantity) === 12.5)
  check('>>> el destino suma SOLO lo contado (48, no 50)',
    Number((await db.stock.findFirstOrThrow({
      where: { productId: prod.productId, warehouseId: w2 },
    })).quantity) === 48)
  check('el origen NO se vuelve a descontar por el faltante',
    Number((await db.stock.findFirstOrThrow({
      where: { productId: prod.productId, warehouseId: wMatriz.id },
    })).quantity) === stockAntes - 50,
    'si bajara más, la merma estaría restando dos veces')
  check('el faltante queda registrado en la línea',
    Number((await db.branchTransferItem.findFirstOrThrow({ where: { id: itCemento.id } })).quantityReceived) === 48)
  check('y auditado como faltante',
    (await db.auditLog.count({ where: { action: 'transfer.receive.faltante', entityId: tr.id } })) === 1)

  console.log('\n   Rechazo: la mercadería vuelve al origen')
  const tr2 = await createTransfer(db, ctx, createTransferSchema.parse({
    fromWarehouseId: wMatriz.id, toBranchId: suc2.id, toWarehouseId: w2,
    items: [{ productId: prod.productId, quantity: 10 }],
  }))
  await approveTransfer(dbAprueba, ctxAprueba, { transferId: tr2.id })
  await shipTransfer(db, ctx, { transferId: tr2.id })
  const antesRechazo = Number((await db.stock.findFirstOrThrow({
    where: { productId: prod.productId, warehouseId: wMatriz.id },
  })).quantity)
  await rejectTransfer(db2, ctx2, rejectTransferSchema.parse({
    transferId: tr2.id, reason: 'Llegó el producto equivocado',
  }))
  check('>>> al rechazar, las 10 unidades vuelven al origen',
    Number((await db.stock.findFirstOrThrow({
      where: { productId: prod.productId, warehouseId: wMatriz.id },
    })).quantity) === antesRechazo + 10)
  check('el motivo del rechazo queda guardado',
    (await db.branchTransfer.findFirstOrThrow({ where: { id: tr2.id } })).rejectReason ===
      'Llegó el producto equivocado')

  console.log('\n   El libro de inventario reconcilia')
  const suma = Number((await db.stockMovement.aggregate({
    where: { productId: prod.productId, warehouseId: wMatriz.id }, _sum: { quantity: true },
  }))._sum.quantity)
  const real = Number((await db.stock.findFirstOrThrow({
    where: { productId: prod.productId, warehouseId: wMatriz.id },
  })).quantity)
  check('>>> SUM(movimientos) del origen = stock real', suma === real, `${suma} vs ${real}`)

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n   >>> El ciclo SEPARADO: solicitar → aprobar → despachar → recibir')
  /*
   * Antes `createTransfer` exigía `despachar`, y solo funcionaba porque el
   * almacenero tenía los dos. Son dos momentos y dos responsabilidades: un
   * vendedor o cajero puede pedir reposición, pero solo el almacenero o el
   * admin despacha.
   */
  const ctxVend: TenantContext = { ...ctx, userId: multi.id, role: 'VENDEDOR' }
  const dbVend = getTenantPrisma(ctxVend)
  const trV = await createTransfer(dbVend, ctxVend, createTransferSchema.parse({
    fromWarehouseId: wMatriz.id, toBranchId: suc2.id, toWarehouseId: w2,
    items: [{ productId: prod.productId, quantity: 1 }],
  }))
  check('>>> un VENDEDOR puede SOLICITAR una transferencia', trV.status === 'SOLICITADA')
  check('>>> pero NO aprobarla', await code(() => approveTransfer(dbVend, ctxVend, { transferId: trV.id })) === 'FORBIDDEN_ROLE')
  await approveTransfer(db, ctx, { transferId: trV.id })
  check('>>> ni despacharla', await code(() => shipTransfer(dbVend, ctxVend, { transferId: trV.id })) === 'FORBIDDEN_ROLE')
  check('>>> ni recibirla', await code(() => receiveTransfer(dbVend, ctxVend, receiveTransferSchema.parse({
    transferId: trV.id, items: [{ itemId: 'x', quantityReceived: 1 }],
  }))) === 'FORBIDDEN_ROLE')
  const stockVend = Number((await db.stock.findFirstOrThrow({
    where: { productId: prod.productId, warehouseId: wMatriz.id },
  })).quantity)
  check('el stock no se movió por haber solicitado ni por los intentos', stockVend === stockAntes - 50,
    `${stockVend} (esperado ${stockAntes - 50}: solo salieron los 50 de la primera transferencia)`)
  const ctxContador: TenantContext = { ...ctx, userId: multi.id, role: 'CONTADOR' }
  check('el CONTADOR no puede ni solicitar', await code(() => createTransfer(
    getTenantPrisma(ctxContador), ctxContador, createTransferSchema.parse({
      fromWarehouseId: wMatriz.id, toBranchId: suc2.id, toWarehouseId: w2,
      items: [{ productId: prod.productId, quantity: 1 }],
    }))) === 'FORBIDDEN_ROLE')
  // Se deja la transferencia resuelta para no contaminar la baja de sucursales.
  await rejectTransfer(db2, ctx2, rejectTransferSchema.parse({
    transferId: trV.id, reason: 'Solicitud de prueba del ciclo separado',
  }))

  console.log('\n   >>> REPOSICIÓN pedida desde el DESTINO (sentido PEDIR)')
  const ctxPide: TenantContext = { ...ctx2, userId: multi.id, role: 'VENDEDOR' }
  const dbPide = getTenantPrisma(ctxPide)
  const stockOrigenAntes = Number((await db.stock.findFirstOrThrow({
    where: { productId: prod.productId, warehouseId: wMatriz.id },
  })).quantity)
  const stockDestinoAntes = Number((await prisma.stock.findFirst({
    where: { productId: prod.productId, warehouseId: w2 },
  }))?.quantity ?? 0)
  check('el esquema exige a quién se le pide',
    !createTransferSchema.safeParse({
      sentido: 'PEDIR', fromWarehouseId: wMatriz.id, toBranchId: suc2.id, toWarehouseId: w2,
      items: [{ productId: prod.productId, quantity: 1 }],
    }).success)
  check('y al ENVIAR no se admite un origen ajeno',
    !createTransferSchema.safeParse({
      sentido: 'ENVIAR', fromBranchId: matriz.id, fromWarehouseId: wMatriz.id, toBranchId: suc2.id, toWarehouseId: w2,
      items: [{ productId: prod.productId, quantity: 1 }],
    }).success)
  const pedido = (extra: Record<string, unknown> = {}) => createTransferSchema.parse({
    sentido: 'PEDIR', fromBranchId: matriz.id, fromWarehouseId: wMatriz.id,
    toBranchId: suc2.id, toWarehouseId: w2,
    items: [{ productId: prod.productId, quantity: 2 }], ...extra,
  })
  const pr = await createTransfer(dbPide, ctxPide, pedido())
  check('>>> el VENDEDOR del destino pide reposición: nace SOLICITADA', pr.status === 'SOLICITADA')
  const fila = await prisma.branchTransfer.findUniqueOrThrow({ where: { id: pr.id } })
  check('>>> el ORIGEN es la sucursal a la que se le pidió y el DESTINO es la mía',
    fila.fromBranchId === matriz.id && fila.toBranchId === suc2.id)
  check('la numeración usa la serie del origen', pr.number.startsWith('T001-'), pr.number)
  check('quien pidió queda como solicitante', fila.requestedById === multi.id)
  check('>>> pedir NO mueve stock',
    Number((await db.stock.findFirstOrThrow({ where: { productId: prod.productId, warehouseId: wMatriz.id } })).quantity) === stockOrigenAntes)
  check('>>> un pedido a un destino que NO es mi sucursal se rechaza',
    await code(() => createTransfer(dbPide, ctxPide, pedido({ toBranchId: matriz.id, toWarehouseId: wMatriz.id, fromBranchId: suc2.id, fromWarehouseId: w2 }))) === 'INVALID_DOCUMENT')
  check('>>> no se le puede pedir a la propia sucursal',
    await code(() => createTransfer(dbPide, ctxPide, pedido({ fromBranchId: suc2.id, fromWarehouseId: w2 }))) === 'INVALID_DOCUMENT')
  check('>>> el almacén tiene que ser de la sucursal a la que se pide',
    await code(() => createTransfer(dbPide, ctxPide, pedido({ fromWarehouseId: w2 }))) === 'TENANT_MISMATCH')
  check('el CONTADOR tampoco puede pedir',
    await code(() => createTransfer(getTenantPrisma({ ...ctxPide, role: 'CONTADOR' }), { ...ctxPide, role: 'CONTADOR' }, pedido())) === 'FORBIDDEN_ROLE')

  await approveTransfer(db, ctx, { transferId: pr.id })
  check('>>> quien pidió no puede despacharlo (no es del origen)',
    await code(() => shipTransfer(dbPide, ctxPide, { transferId: pr.id })) === 'FORBIDDEN_ROLE')
  await shipTransfer(db, ctx, { transferId: pr.id })
  check('>>> el stock SALE del origen al despachar',
    Number((await db.stock.findFirstOrThrow({ where: { productId: prod.productId, warehouseId: wMatriz.id } })).quantity) === stockOrigenAntes - 2)
  const itemsPr = await prisma.branchTransferItem.findMany({ where: { transferId: pr.id } })
  await receiveTransfer(db2, ctx2, receiveTransferSchema.parse({
    transferId: pr.id, items: itemsPr.map((i) => ({ itemId: i.id, quantityReceived: 2 })),
  }))
  check('>>> y ENTRA al destino que pidió al recibir',
    Number((await prisma.stock.findFirstOrThrow({ where: { productId: prod.productId, warehouseId: w2 } })).quantity) === stockDestinoAntes + 2)
  check('quedó RECIBIDA', (await prisma.branchTransfer.findUniqueOrThrow({ where: { id: pr.id } })).status === 'RECIBIDA')
  const auditPr = await db.auditLog.findFirst({ where: { action: 'transfer.create', entityId: pr.id } })
  check('la auditoría registra el sentido', JSON.stringify(auditPr?.after ?? '').includes('PEDIR'))

  console.log('\n9) Asignación de usuarios a sucursales')
  const cajero = await prisma.user.create({
    data: { email: `c-${M}@x.com`, name: 'Cajero', role: 'VENDEDOR', tenantId: t.id },
  })
  const asig = await assignBranches(db, ctx, assignBranchesSchema.parse({
    userId: cajero.id, branchIds: [suc2.id],
  }))
  check('se le asigna una sucursal', asig.asignadas === 1)
  check('reasignar REEMPLAZA en vez de acumular (idempotente)',
    (await assignBranches(db, ctx, assignBranchesSchema.parse({
      userId: cajero.id, branchIds: [matriz.id],
    }))).asignadas === 1 &&
    (await db.userBranch.count({ where: { userId: cajero.id } })) === 1)
  check('una sucursal inexistente rechaza la operación COMPLETA',
    await code(() => assignBranches(db, ctx, assignBranchesSchema.parse({
      userId: cajero.id, branchIds: [matriz.id, 'inventada'],
    }))) === 'NOT_FOUND')
  check('y no dejó la asignación a medias',
    (await db.userBranch.count({ where: { userId: cajero.id } })) === 1)

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n10) Baja de sucursal (soft delete, Frente 1)')
  check('>>> no se da de baja una sucursal CON STOCK dentro',
    await code(() => deleteBranch(db, ctx, deleteBranchSchema.parse({
      branchId: suc2.id, reason: 'Cierre del local',
    }))) === 'INVALID_DOCUMENT')
  check('la casa matriz NUNCA se da de baja',
    await code(() => deleteBranch(db, ctx, deleteBranchSchema.parse({
      branchId: matriz.id, reason: 'Prueba',
    }))) === 'INVALID_DOCUMENT')

  const vacia = await createBranch(db, ctx, createBranchSchema.parse({
    code: 'VACIA', name: 'Local vacío', establishmentCode: '0007',
  }))
  const baja = await deleteBranch(db, ctx, deleteBranchSchema.parse({
    branchId: vacia.id, reason: 'No se llegó a abrir',
  }))
  const filaBaja = await db.branch.findFirstOrThrow({ where: { id: baja.id } })
  check('la fila SIGUE existiendo: es baja lógica', filaBaja.deletedAt !== null)
  check('y queda inactiva', filaBaja.isActive === false)
  check('sus almacenes se desactivan con ella',
    (await db.warehouse.count({ where: { branchId: vacia.id, isActive: true } })) === 0)
  check('el motivo queda en la auditoría',
    (await db.auditLog.findFirstOrThrow({ where: { action: 'branch.delete', entityId: vacia.id } }))
      .reason === 'No se llegó a abrir')
  check('>>> su número de serie NO se reutiliza (la serie quedó quemada)',
    siguienteSeriesNumber(
      (await db.branch.findMany({ select: { seriesNumber: true } })).map((b) => b.seriesNumber),
    ) !== filaBaja.seriesNumber)
  check('una sucursal dada de baja no puede emitir',
    await code(() => registerSale(
      getTenantPrisma({ ...ctx, branchId: vacia.id }), { ...ctx, branchId: vacia.id },
      registerSaleSchema.parse({
        warehouseId: wMatriz.id, items: [{ productId: prod.productId, quantity: 1 }],
        payments: [{ method: 'EFECTIVO', amount: 32.9 }],
      }))) === 'TENANT_MISMATCH')

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n11) Límite de sucursales del plan')
  const planTope = await prisma.plan.create({
    data: {
      code: `tope-${M}`, name: 'Tope', priceMonthly: '1', priceYearly: '1', maxBranches: 1,
    },
  })
  const tTope = await prisma.tenant.create({
    data: { slug: `tope-${M}`, name: 'Tope', planId: planTope.id },
  })
  const uTope = await prisma.user.create({
    data: { email: `tope-${M}@x.com`, name: 'T', role: 'OWNER', tenantId: tTope.id },
  })
  const bTope = await crearSucursal(tTope.id)
  const ctxTope: TenantContext = {
    tenantId: tTope.id, userId: uTope.id, role: 'OWNER', access: 'FULL', branchId: bTope.id,
  }
  check('>>> con maxBranches=1 y una existente, la segunda se rechaza',
    await code(() => createBranch(getTenantPrisma(ctxTope), ctxTope, createBranchSchema.parse({
      code: 'DOS', name: 'Dos', establishmentCode: '0001',
    }))) === 'PLAN_LIMIT_REACHED')

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n12) Limpieza')
  for (const id of [t.id, tTope.id]) {
    await prisma.taxDocument.deleteMany({ where: { tenantId: id } })
    await prisma.tenant.delete({ where: { id } })
  }
  await prisma.plan.delete({ where: { id: planTope.id } })
  check('datos de prueba eliminados',
    (await prisma.tenant.count({ where: { id: { in: [t.id, tTope.id] } } })) === 0)

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
