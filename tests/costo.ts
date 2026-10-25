import './guard'
import { correr } from './teardown'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { join } from 'node:path'
import { SyntaxKind } from 'ts-morph'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarCostoEntrada, createStockMovement } from '../src/features/inventory/stock-service'
import { createProductExpress } from '../src/features/inventory/product-service'
import { createStockMovementSchema, createProductExpressSchema } from '../src/features/inventory/schemas'
import type { TenantContext } from '../src/lib/tenant-context'
import { RAIZ, abrir, ficheros, identificadores, proyecto, rel } from './ast'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? String(e))

async function main() {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({
    data: { slug: `cs-${randomUUID().slice(0, 8)}`, name: 'Costo Test', planId: plan.id },
  })
  const mk = (role: 'OWNER' | 'ALMACENERO' | 'CONTADOR') =>
    prisma.user.create({ data: { email: `${role}-${randomUUID()}@x.com`, name: role, role, tenantId: t.id } })
  const [owner, alm] = await Promise.all([mk('OWNER'), mk('ALMACENERO')])
  const { branch, warehouse: w } = await crearSucursalConAlmacen(t.id)
  await asignarSucursal(t.id, owner.id, branch.id)
  await asignarSucursal(t.id, alm.id, branch.id)
  const base = { tenantId: t.id, access: 'FULL' as const, branchId: branch.id }
  const cOwner: TenantContext = { ...base, userId: owner.id, role: 'OWNER' }
  const cAlm: TenantContext = { ...base, userId: alm.id, role: 'ALMACENERO' }
  const dbO = getTenantPrisma(cOwner)
  const dbA = getTenantPrisma(cAlm)
  const p = await prisma.product.create({ data: { tenantId: t.id, sku: 'COSTO-1', name: 'Cemento', costPrice: 10 } })
  const parse = (i: unknown) => createStockMovementSchema.parse(i)

  console.log('\n1) Entrada de mercadería sin ver ni teclear el costo')
  const e1 = await createStockMovement(dbA, cAlm, parse({
    type: 'ENTRADA', productId: p.id, warehouseId: w.id, quantity: 50,
  }))
  const m1 = await dbO.stockMovement.findUniqueOrThrow({ where: { id: e1.movementId } })
  check('ALMACENERO registra la entrada con cantidad', e1.balanceAfter === 50)
  check('>>> queda «costo pendiente» y sin costo', m1.costPending === true && m1.unitCost === null)
  check('>>> ALMACENERO que teclea un costo es rechazado',
    await code(createStockMovement(dbA, cAlm, parse({
      type: 'ENTRADA', productId: p.id, warehouseId: w.id, quantity: 1, unitCost: 5,
    }))) === 'FORBIDDEN_ROLE')

  console.log('\n2) Completar el costo')
  check('>>> ALMACENERO no puede completar el costo',
    await code(completarCostoEntrada(dbA, cAlm, e1.movementId, 9)) === 'FORBIDDEN_ROLE')
  await completarCostoEntrada(dbO, cOwner, e1.movementId, 9.5)
  const m2 = await dbO.stockMovement.findUniqueOrThrow({ where: { id: e1.movementId } })
  check('OWNER completa: costo fijado y deja de estar pendiente',
    m2.costPending === false && m2.unitCost?.toNumber() === 9.5)
  check('queda auditado con el estado anterior y el nuevo',
    (await dbO.auditLog.count({ where: { action: 'stock.completar_costo', entityId: e1.movementId } })) === 1)
  check('>>> un costo ya fijado no se reescribe por esta vía',
    await code(completarCostoEntrada(dbO, cOwner, e1.movementId, 1)) === 'NOT_FOUND')
  const e2 = await createStockMovement(dbO, cOwner, parse({
    type: 'ENTRADA', productId: p.id, warehouseId: w.id, quantity: 5, unitCost: 8,
  }))
  const m3 = await dbO.stockMovement.findUniqueOrThrow({ where: { id: e2.movementId } })
  check('OWNER con costo: no queda pendiente', m3.costPending === false && m3.unitCost?.toNumber() === 8)

  console.log('\n3) Alta exprés')
  const ex = (name: string, costPrice?: number) => createProductExpressSchema.parse({
    name, salePrice: 5, warehouseId: w.id, ...(costPrice !== undefined ? { costPrice } : {}),
  })
  check('>>> ALMACENERO con costo en el alta exprés es rechazado',
    await code(createProductExpress(dbA, cAlm, ex('Clavo', 2))) === 'FORBIDDEN_ROLE')
  check('ALMACENERO sin costo: alta normal',
    await createProductExpress(dbA, cAlm, ex('Alambre')).then(() => true).catch(() => false))

  console.log('\n4) >>> AST: dónde puede aparecer el costo')
  /*
   * El costo no debe poder colarse por un select nuevo. Solo estos archivos
   * nombran `costPrice`/`unitCost`, y cada uno tiene una razón:
   *   sale-service     congela el costo en la línea de venta (no lo devuelve)
   *   stock-service    escribe unitCost y exige productos.ver_costo
   *   product-service  alta exprés: exige productos.ver_costo
   *   import-service   exige ver_costo y revalida en commit
   *   presentaciones-service   el costo de una presentación exige ver_costo
   *   schemas, csv     forma del dato y alias de columna
   *   CatalogImport    vista previa; el servidor ya rechazó el costo
   *   actions + CostosPendientes   completar costos: exige productos.ver_costo en página y servicio
   */
  const PERMITIDOS = new Set([
    'src/features/pos/sale-service.ts',
    'src/features/inventory/stock-service.ts',
    'src/features/inventory/product-service.ts',
    'src/features/inventory/import-service.ts',
    // Alta de presentaciones: el costo propio de una presentación exige productos.ver_costo (lo comprueba el servicio).
    'src/features/inventory/presentaciones-service.ts',
    'src/features/inventory/schemas.ts',
    'src/features/inventory/csv.ts',
    'src/features/inventory/components/CatalogImport.tsx',
    // Pantalla de costos pendientes: la página es 404 sin productos.ver_costo y
    // el servicio también lo exige; la acción solo lleva el valor al servicio.
    'src/features/inventory/actions.ts',
    'src/features/inventory/components/CostosPendientes.tsx',
  ])
  const proj = proyecto()
  const fuentes = ficheros(join(RAIZ, 'src'), (f) => f.endsWith('.ts') || f.endsWith('.tsx'))
    .map(rel).filter((r) => !r.includes('/generated/'))
  const arboles = new Map(fuentes.map((r) => [r, abrir(proj, r)]))
  const conCosto = fuentes.filter((r) => {
    const ids = identificadores(arboles.get(r)!)
    return ids.has('costPrice') || ids.has('unitCost')
  })
  const fuera = conCosto.filter((r) => !PERMITIDOS.has(r))
  check('>>> solo los archivos autorizados nombran costPrice/unitCost', fuera.length === 0, fuera.join(', '))

  // Un `product.findMany()` SIN select devuelve costPrice. Todo acceso a
  // Product o StockMovement fuera de la lista debe llevar `select`.
  const sinSelect: string[] = []
  for (const r of fuentes) {
    if (PERMITIDOS.has(r)) continue
    for (const c of arboles.get(r)!.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const f = c.getExpression()
      if (!f.isKind(SyntaxKind.PropertyAccessExpression)) continue
      const metodo = f.getName()
      if (!/^(findMany|findFirst|findUnique|findFirstOrThrow|findUniqueOrThrow|create|update|upsert)$/.test(metodo)) continue
      const modelo = f.getExpression()
      if (!modelo.isKind(SyntaxKind.PropertyAccessExpression)) continue
      if (!/^(product|productVariant|stockMovement)$/.test(modelo.getName())) continue
      const arg = c.getArguments()[0]
      const tieneSelect = !!arg && arg.isKind(SyntaxKind.ObjectLiteralExpression) &&
        arg.getProperties().some((pr) => pr.isKind(SyntaxKind.PropertyAssignment) && pr.getName() === 'select')
      if (!tieneSelect) sinSelect.push(`${r}:${c.getStartLineNumber()} ${modelo.getName()}.${metodo}`)
    }
  }
  check('>>> ningún acceso a Product/StockMovement sin `select` fuera de los autorizados',
    sinSelect.length === 0, sinSelect.join(' | '))

  await prisma.tenant.delete({ where: { id: t.id } })
  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
