import { reconstruirCostos, type MovimientoHistorico, type CostoReconstruido } from '../src/features/inventory/kardex-reconstruccion'

/**
 * F6.4a · La reconstrucción del costo de los movimientos anteriores al kardex valorizado, PURA (sin base): repite compras y anulaciones con la fórmula
 * del promedio ponderado, se ancla en el costo real que guardó cada venta, respeta lo que el sistema ya escribió y no inventa cifras sin costo.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
// Una excepción cuenta como fallo de la prueba (✗), no como un aborto sin veredicto.
const rec = (m: MovimientoHistorico[]): CostoReconstruido[] => { try { return reconstruirCostos(m) } catch (e) { console.log(`    (excepción: ${e instanceof Error ? e.message : e})`); return [] } }

let n = 0
const mov = (o: Partial<MovimientoHistorico> & { quantity: number; balanceAfter: number }): MovimientoHistorico => ({
  id: `m${++n}`, filaStock: 'w1|', type: o.quantity >= 0 ? 'ENTRADA' : 'SALIDA', source: 'MANUAL', unitCost: null, referenceType: 'MANUAL', costPending: false,
  origenGuardado: 'SIN_DATO', costAfterGuardado: null, costoVenta: null, costoCompra: null, ...o,
})
const compra = (q: number, costo: number, saldo: number, o: Partial<MovimientoHistorico> = {}) => mov({ quantity: q, balanceAfter: saldo, unitCost: costo, referenceType: 'COMPRA', ...o })
const venta = (q: number, saldo: number, costoVenta: number | null, o: Partial<MovimientoHistorico> = {}) => mov({ quantity: -q, balanceAfter: saldo, source: 'VENTA', type: 'SALIDA', referenceType: 'VENTA', costoVenta, ...o })
const por = (r: CostoReconstruido[], id: string) => r.find((x) => x.id === id)

console.log('\nA) Compras y ventas')
{
  const a = compra(10, 5, 10), b = compra(10, 7, 20), v = venta(4, 16, 6)
  const r = rec([a, b, v])
  check('>>> compra 1: valora a 5, promedio 5, RECONSTRUIDO', por(r, a.id)?.unitCostApplied === 5 && por(r, a.id)?.costAfter === 5 && por(r, a.id)?.costOrigin === 'RECONSTRUIDO')
  check('>>> compra 2 (10 a 7 sobre 10 a 5): promedio 6', por(r, b.id)?.unitCostApplied === 7 && por(r, b.id)?.costAfter === 6 && por(r, b.id)?.costOrigin === 'RECONSTRUIDO')
  check('>>> la venta con su costo real (6) es EXACTO: valora a 6 y deja el promedio 6', por(r, v.id)?.unitCostApplied === 6 && por(r, v.id)?.costAfter === 6 && por(r, v.id)?.costOrigin === 'EXACTO')
}
{
  const a = compra(10, 5, 10), v = venta(2, 8, 6), s = mov({ quantity: -1, balanceAfter: 7 }), c = compra(10, 8, 17)
  const r = rec([a, v, s, c])
  check('>>> el costo de una venta es un ancla: si el promedio había cambiado a mano (5 → 6), la venta lo corrige y lo que sigue parte de ahí', por(r, v.id)?.costAfter === 6 && por(r, s.id)?.costAfter === 6 && por(r, s.id)?.unitCostApplied === 6)
  // Compra de 10 a 8 con 7 en stock a 6: (7·6 + 80) / 17 = 7.1765
  check('>>> y la compra siguiente promedia desde el ancla, no desde el valor viejo', por(r, c.id)?.costAfter === 7.1765, String(por(r, c.id)?.costAfter))
}
{
  const a = compra(10, 5, 10), v = venta(3, 7, null)
  const r = rec([a, v])
  check('>>> una venta SIN línea conocida se valora al promedio reconstruido (5) y es RECONSTRUIDO, no EXACTO', por(r, v.id)?.unitCostApplied === 5 && por(r, v.id)?.costAfter === 5 && por(r, v.id)?.costOrigin === 'RECONSTRUIDO')
}

console.log('\nB) Anulación de compra')
{
  const a = compra(10, 5, 10), b = compra(10, 7, 20)
  const an = mov({ quantity: -10, balanceAfter: 10, type: 'DEVOLUCION_PROVEEDOR', referenceType: 'COMPRA', costoCompra: 7 })
  const r = rec([a, b, an])
  // (20·6 − 70) / 10 = 5
  check('>>> anular la compra 2 devuelve al costo de la FACTURA (7) y el promedio vuelve a 5', por(r, an.id)?.unitCostApplied === 7 && por(r, an.id)?.costAfter === 5 && por(r, an.id)?.costOrigin === 'RECONSTRUIDO', JSON.stringify(por(r, an.id)))
}
{
  const a = compra(10, 5, 10), an = mov({ quantity: -10, balanceAfter: 0, type: 'DEVOLUCION_PROVEEDOR', referenceType: 'COMPRA', costoCompra: 5 })
  const r = rec([a, an])
  check('>>> si la anulación deja el stock en 0, no se toca el promedio (regla de compras)', por(r, an.id)?.costAfter === 5)
}
{
  const a = compra(10, 5, 10), an = mov({ quantity: -4, balanceAfter: 6, type: 'DEVOLUCION_PROVEEDOR', referenceType: 'COMPRA', costoCompra: null })
  const r = rec([a, an])
  check('>>> una anulación sin costo de factura conocido cae al promedio reconstruido, sin inventar la fórmula', por(r, an.id)?.unitCostApplied === 5 && por(r, an.id)?.costAfter === 5)
}

console.log('\nC) Lo que no se puede saber, no se inventa')
{
  const e = mov({ quantity: 5, balanceAfter: 5, type: 'ENTRADA', costPending: true })
  const s = mov({ quantity: -2, balanceAfter: 3 })
  const r = rec([e, s])
  check('>>> sin ningún costo conocido: SIN_DATO y sin cifras', por(r, e.id)?.costOrigin === 'SIN_DATO' && por(r, e.id)?.costAfter === null && por(r, e.id)?.unitCostApplied === null && por(r, s.id)?.costOrigin === 'SIN_DATO' && por(r, s.id)?.costAfter === null)
}
{
  const e = mov({ quantity: 5, balanceAfter: 5, type: 'ENTRADA', costPending: true }), c = compra(5, 4, 10), s = mov({ quantity: -2, balanceAfter: 8 })
  const r = rec([e, c, s])
  check('>>> la entrada sin costo anterior a la primera compra queda SIN_DATO; lo posterior sí se valora', por(r, e.id)?.costOrigin === 'SIN_DATO' && por(r, c.id)?.costOrigin === 'RECONSTRUIDO' && por(r, s.id)?.costAfter === por(r, c.id)?.costAfter)
}
{
  const e = mov({ quantity: 5, balanceAfter: 15, type: 'ENTRADA', costPending: true }), c = compra(10, 4, 25)
  const r = rec([mov({ quantity: 10, balanceAfter: 10, type: 'INICIAL', unitCost: 3 }), e, c])
  check('>>> una entrada manual sin costo, ya con costo conocido, queda con valor aplicado NULL pero con el promedio vigente', por(r, e.id)?.unitCostApplied === null && por(r, e.id)?.costAfter === 3 && por(r, e.id)?.costOrigin === 'RECONSTRUIDO')
}

console.log('\nD) Stock inicial, entradas manuales, devoluciones y transferencias')
{
  const i = mov({ quantity: 10, balanceAfter: 10, type: 'INICIAL', unitCost: 3 }), m = mov({ quantity: 5, balanceAfter: 15, unitCost: 9 })
  const r = rec([i, m])
  check('>>> el stock inicial con costo 3 fija el promedio en 3', por(r, i.id)?.unitCostApplied === 3 && por(r, i.id)?.costAfter === 3)
  check('>>> una entrada manual con costo 9 se valora a 9 pero NO mueve el promedio (3), como hoy', por(r, m.id)?.unitCostApplied === 9 && por(r, m.id)?.costAfter === 3)
}
{
  const a = compra(10, 5, 10), v = venta(4, 6, 5), d = mov({ quantity: 4, balanceAfter: 10, type: 'DEVOLUCION_CLIENTE', unitCost: 4, referenceType: 'DEVOLUCION' })
  const r = rec([a, v, d])
  check('>>> la devolución de cliente se valora al costo de la venta (4) y deja el promedio como estaba (5)', por(r, d.id)?.unitCostApplied === 4 && por(r, d.id)?.costAfter === 5)
}
{
  const a = compra(10, 5, 10)
  const ts = mov({ quantity: -3, balanceAfter: 7, type: 'TRANSFERENCIA_SALIDA', filaStock: 'w1|' }), te = mov({ quantity: 3, balanceAfter: 3, type: 'TRANSFERENCIA_ENTRADA', filaStock: 'w2|' })
  const r = rec([a, ts, te])
  check('>>> las dos piernas de una transferencia se valoran al promedio vigente (la entrada no es «costo pendiente»)', por(r, ts.id)?.unitCostApplied === 5 && por(r, te.id)?.unitCostApplied === 5 && por(r, te.id)?.costAfter === 5)
}

console.log('\nE) El promedio pesa por TODO el stock del producto (todos los almacenes), y lo negativo no pesa')
{
  const a = compra(10, 5, 10, { filaStock: 'w1|' }), b = compra(10, 8, 10, { filaStock: 'w2|' })
  const r = rec([a, b])
  check('>>> la compra en otro almacén promedia con el stock de ambos (10 a 5 + 10 a 8 → 6.5)', por(r, b.id)?.costAfter === 6.5)
}
{
  const a = compra(10, 5, 10), v = venta(15, -5, null), b = compra(10, 9, 5)
  const r = rec([a, v, b])
  check('>>> con stock negativo antes de la compra, lo negativo no pesa: el promedio es el de la compra (9)', por(r, b.id)?.costAfter === 9, String(por(r, b.id)?.costAfter))
}
{
  const a = compra(10, 5, 15)   // había 5 sin movimientos registrados: la fila arrancó en 5
  const b = compra(10, 8, 25)
  const r = rec([a, b])
  // a: (5·0 ... costo 0 no pesa) → 5; b: (15·5 + 80)/25 = 6.2
  check('>>> el stock anterior al primer movimiento registrado cuenta (balanceAfter − quantity)', por(r, b.id)?.costAfter === 6.2, String(por(r, b.id)?.costAfter))
}

console.log('\nF) Respetar lo ya escrito y propiedades generales')
{
  const exacto = mov({ quantity: -1, balanceAfter: 9, origenGuardado: 'EXACTO', costAfterGuardado: 7 })
  const a = compra(10, 5, 10), after = mov({ quantity: -1, balanceAfter: 8 })
  const r = rec([a, exacto, after])
  check('>>> un movimiento ya EXACTO no se devuelve (no se reescribe)', por(r, exacto.id) === undefined)
  check('>>> pero fija el promedio con el que sigue la historia (7)', por(r, after.id)?.costAfter === 7 && por(r, after.id)?.unitCostApplied === 7)
}
{
  const a = compra(10, 5, 10), b = compra(10, 7, 20), v = venta(4, 16, 6), s = mov({ quantity: -1, balanceAfter: 15 }), e = mov({ quantity: 2, balanceAfter: 17, costPending: true })
  const hist = [a, b, v, s, e]
  const r1 = rec(hist), r2 = rec(hist)
  check('>>> es determinista: dos corridas dan exactamente lo mismo', JSON.stringify(r1) === JSON.stringify(r2))
  check('>>> devuelve un resultado por cada movimiento SIN_DATO y ninguno repetido', r1.length === hist.length && new Set(r1.map((x) => x.id)).size === hist.length)
  check('>>> invariante de la base: SIN_DATO nunca trae cifras y todo lo demás trae el promedio', r1.every((x) => x.costOrigin === 'SIN_DATO' ? x.costAfter === null && x.unitCostApplied === null : x.costAfter !== null && x.costAfter >= 0 && (x.unitCostApplied === null || x.unitCostApplied >= 0)))
  check('>>> no modifica la lista que recibe', hist.every((m) => m.origenGuardado === 'SIN_DATO'))
  check('>>> sin movimientos no hay nada que hacer', rec([]).length === 0)
}

console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
process.exit(fail === 0 ? 0 : 1)
