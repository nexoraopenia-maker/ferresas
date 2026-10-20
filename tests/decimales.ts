import { tieneMaxDecimales } from '../src/lib/dinero'
import { registerSaleSchema, paymentLineSchema } from '../src/features/pos/schemas'
import { createStockMovementSchema } from '../src/features/inventory/schemas'
import { solicitarMermaSchema } from '../src/features/inventory/merma-schemas'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}

/**
 * El defecto: `Math.round(n * 100) === n * 100` rechazaba importes normales.
 * En coma flotante 1.1 * 100 es 110.00000000000001, así que un descuento de
 * S/ 1,10 o un cobro de S/ 8,20 daban «Máximo 2 decimales».
 */
console.log('\n1) Importes normales que antes se rechazaban')
const antes = (n: number) => Math.round(n * 100) === n * 100
const importes = [1.1, 4.35, 0.07, 8.2, 1.15, 2.3, 19.99, 0.57, 32.9, 100, 0.01, 1234.56]
const rotosAntes = importes.filter((n) => !antes(n))
check(`el criterio antiguo fallaba con ${rotosAntes.length} de ${importes.length} importes (prueba de que el defecto era real)`, rotosAntes.length >= 6, rotosAntes.join(', '))
check('>>> el criterio nuevo acepta TODOS', importes.every((n) => tieneMaxDecimales(n, 2)))
check('barrido de 0,01 a 500,00: ningún importe de 2 decimales se rechaza',
  Array.from({ length: 50_000 }, (_, i) => (i + 1) / 100).every((n) => tieneMaxDecimales(n, 2)))

console.log('\n2) Lo que SÍ se rechaza')
check('1.005 (tres decimales) se rechaza', !tieneMaxDecimales(1.005, 2))
check('0.001 se rechaza', !tieneMaxDecimales(0.001, 2))
check('12.3456 vale con 4 decimales y no con 2', tieneMaxDecimales(12.3456, 4) && !tieneMaxDecimales(12.3456, 2))
check('NaN e Infinity no valen', !tieneMaxDecimales(NaN, 2) && !tieneMaxDecimales(Infinity, 2))
check('1.00001 no vale con 4 decimales', !tieneMaxDecimales(1.00001, 4))

console.log('\n3) Cantidades de 4 decimales (un cable de 2,345 m)')
const cant = [2.345, 1.001, 0.0007, 0.35, 12.5, 7.1234, 0.1, 3]
check('>>> el criterio antiguo también fallaba aquí', cant.some((n) => Math.round(n * 10_000) !== n * 10_000))
check('el nuevo las acepta todas', cant.every((n) => tieneMaxDecimales(n, 4)))

console.log('\n4) En los esquemas reales')
const venta = (discount: number, amount: number, quantity = 1) => registerSaleSchema.safeParse({
  warehouseId: 'w', items: [{ productId: 'p', quantity, discount }], payments: [{ method: 'EFECTIVO', amount }],
})
check('>>> descuento de 1,10 y cobro de 8,20', venta(1.1, 8.2).success)
check('cantidad vendida de 2,345 (kg)', venta(0, 8.2, 2.345).success)
check('un descuento de 3 decimales se sigue rechazando', !venta(1.005, 8.2).success)
check('un cobro de 3 decimales se sigue rechazando', !paymentLineSchema.safeParse({ method: 'EFECTIVO', amount: 1.005 }).success)
check('>>> entrada de stock de 1,001 unidades', createStockMovementSchema.safeParse({ type: 'ENTRADA', productId: 'p', warehouseId: 'w', quantity: 1.001 }).success)
check('y de 5 decimales no', !createStockMovementSchema.safeParse({ type: 'ENTRADA', productId: 'p', warehouseId: 'w', quantity: 1.00001 }).success)
check('merma de 2,345', solicitarMermaSchema.safeParse({ warehouseId: 'w', productId: 'p', quantity: 2.345, reason: 'Se cayó el rollo y quedó inservible' }).success)

console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
process.exit(fail === 0 ? 0 : 1)
