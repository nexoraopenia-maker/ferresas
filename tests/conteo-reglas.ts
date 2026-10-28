import { LOTE_APLICACION, LOTE_APROBACION, UMBRAL_PORCENTAJE_DIFERENCIA, UMBRAL_VALOR_DIFERENCIA, diferenciaDeConteo, evaluarLinea, stockTrasAplicar } from '../src/features/inventory/conteo-reglas'
import { aplicarConteoSchema, aprobarLineaSchema, aprobarSinAlertaSchema, recontarLineaSchema, rechazarLineaSchema, revisionSchema } from '../src/features/inventory/conteo-schemas'

/**
 * F6.5b · Las reglas PURAS de la revisión de un conteo: la diferencia relativa (exacta en 4 decimales), los umbrales operativos (> S/ 200 al costo vigente o > 10 % de lo
 * esperado, con sus bordes), el stock que queda al aplicar y los esquemas de las acciones.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
// Una excepción cuenta como fallo de la prueba (✗), no como un aborto sin veredicto.
const ev = (c: number, s: number, costo: number | null) => { try { return evaluarLinea({ contado: c, sistema: s, costo }) } catch (e) { console.log(`    (excepción: ${e instanceof Error ? e.message : e})`); return null } }

console.log('\nA) La diferencia es exacta')
check('>>> contado − sistema: sobrante positivo, faltante negativo', diferenciaDeConteo(12, 10) === 2 && diferenciaDeConteo(8, 10) === -2 && diferenciaDeConteo(10, 10) === 0)
check('>>> sin errores de coma flotante: 0.3 − 0.1 = 0.2 exacto y 1.1 − 1 = 0.1', diferenciaDeConteo(0.3, 0.1) === 0.2 && diferenciaDeConteo(1.1, 1) === 0.1 && diferenciaDeConteo(0.7, 0.1) === 0.6 && diferenciaDeConteo(4.35, 4.3) === 0.05)
check('>>> con el stock del sistema negativo la diferencia sigue siendo contado − sistema (−3 → contado 0 = +3)', diferenciaDeConteo(0, -3) === 3)
check('>>> hasta 4 decimales (0.0001 es la unidad mínima)', diferenciaDeConteo(1.0001, 1) === 0.0001 && diferenciaDeConteo(2.5, 2.4999) === 0.0001)
check('>>> el stock tras aplicar es el de AHORA más la diferencia (las ventas posteriores se conservan)', stockTrasAplicar(7, -2) === 5 && stockTrasAplicar(17, 3) === 20 && stockTrasAplicar(0.3, 0.1) === 0.4 && stockTrasAplicar(2, -5) === -3)

console.log('\nB) Umbral por porcentaje: MAYOR que el 10 % de lo esperado')
check('>>> exactamente 10 % NO es sobre el umbral (es «mayor que», no «mayor o igual»)', ev(110, 100, 1)?.sobrePorcentaje === false && ev(90, 100, 1)?.sobrePorcentaje === false && ev(11, 10, 1)?.sobrePorcentaje === false)
check('>>> un poco más de 10 % sí (100.0001 sobre 1000 no; 1100.0001 sobre 1000 sí)', ev(1100.0001, 1000, 1)?.sobrePorcentaje === true && ev(900, 1000, 1)?.sobrePorcentaje === false && ev(899.9999, 1000, 1)?.sobrePorcentaje === true)
check('>>> el porcentaje se mide sobre el valor ABSOLUTO del sistema (sistema negativo también)', ev(-2.5, -3, 1)?.sobrePorcentaje === true && ev(-2.9, -3, 1)?.sobrePorcentaje === false)
check('>>> si el sistema esperaba CERO y se contó algo, el porcentaje no está definido (null) y cuenta como grande', (() => { const r = ev(3, 0, 1); return r?.porcentaje === null && r.sobrePorcentaje === true && r.causas.includes('PORCENTAJE') })())
check('>>> si el sistema esperaba cero y se contó cero, no hay nada', (() => { const r = ev(0, 0, 1); return r?.diferencia === 0 && r.porcentaje === 0 && !r.sobreUmbral && r.causas.length === 0 })())
check('>>> sin diferencia nunca hay alerta, por grande que sea el stock', ev(5000, 5000, 999)?.sobreUmbral === false)
check('>>> el porcentaje que se informa es |diferencia| / |sistema|', ev(8, 10, 1)?.porcentaje === 0.2 && ev(13, 10, 1)?.porcentaje === 0.3)

console.log('\nC) Umbral por valor: MAYOR que S/ 200 al costo promedio vigente')
check('>>> exactamente S/ 200.00 NO es sobre el umbral; un céntimo más sí', ev(1050, 1000, 4)?.valor === 200 && ev(1050, 1000, 4)?.sobreValor === false && ev(1050.0025, 1000, 4)?.sobreValor === true)
check('>>> 50 unidades a S/ 5 = S/ 250: sobre el umbral por VALOR aunque sea solo 5 % (no es por porcentaje)', (() => { const r = ev(1050, 1000, 5); return r?.valor === 250 && r.sobreValor && !r.sobrePorcentaje && r.causas.join() === 'VALOR' })())
check('>>> 3 unidades a S/ 50 = S/ 150 (sobre 1000) no alerta', (() => { const r = ev(1003, 1000, 50); return r?.valor === 150 && !r.sobreUmbral })())
check('>>> el valor es el de la diferencia en valor absoluto (un faltante de S/ 250 también)', (() => { const r = ev(950, 1000, 5); return r?.valor === 250 && r.sobreValor })())
check('>>> con costos de 4 decimales no se pierden céntimos: 1000 u a S/ 0.2001 = S/ 200.10 > 200', (() => { const r = ev(2000, 1000, 0.2001); return r?.valor === 200.1 && r.sobreValor })())
check('>>> el valor se redondea a céntimos (3 u a S/ 0.10 = S/ 0.30, no 0.30000000000000004) y la diferencia conserva sus decimales (2.5 − 1.2 = 1.3)', ev(1003, 1000, 0.1)?.valor === 0.3 && ev(2.5, 1.2, 1)?.diferencia === 1.3 && ev(0.5, 0.25, 1)?.diferencia === 0.25)
check('>>> las dos causas a la vez: 100 → 130 a S/ 10 (30 % y S/ 300)', ev(130, 100, 10)?.causas.join() === 'PORCENTAJE,VALOR')
check('>>> sin costo (null o 0) el valor no se calcula, se marca «sin costo» y solo rige el porcentaje', (() => { const a = ev(12, 10, null), b = ev(12, 10, 0), c = ev(1001, 1000, null); return !!a && a.sinCosto && a.valor === null && !a.sobreValor && a.sobrePorcentaje && !!b && b.sinCosto && !!c && c.sinCosto && !c.sobreUmbral })())
check('>>> con costo, no está «sin costo»', ev(12, 10, 3)?.sinCosto === false)

console.log('\nD) Constantes y esquemas')
check('>>> constantes operativas ⚠️: S/ 200, 10 %, tandas de 500', UMBRAL_VALOR_DIFERENCIA === 200 && UMBRAL_PORCENTAJE_DIFERENCIA === 0.1 && LOTE_APLICACION === 500 && LOTE_APROBACION === 500)
check('>>> recontar y rechazar piden motivo (3 a 280 letras); aprobar admite nota opcional', recontarLineaSchema.safeParse({ countId: 'c', itemId: 'i', reason: 'Parece poco' }).success && !recontarLineaSchema.safeParse({ countId: 'c', itemId: 'i', reason: 'ab' }).success && rechazarLineaSchema.safeParse({ countId: 'c', itemId: 'i', reason: 'Se vendió sin registrar' }).success && !rechazarLineaSchema.safeParse({ countId: 'c', itemId: 'i' }).success && aprobarLineaSchema.safeParse({ countId: 'c', itemId: 'i' }).success && !aprobarLineaSchema.safeParse({ countId: 'c', itemId: 'i', note: 'x'.repeat(281) }).success)
check('>>> aprobar NO confirma el umbral por defecto (hay que decirlo expresamente)', (() => { const r = aprobarLineaSchema.safeParse({ countId: 'c', itemId: 'i' }); return r.success && r.data.confirmaUmbral === false })() && aprobarLineaSchema.safeParse({ countId: 'c', itemId: 'i', confirmaUmbral: true }).success && !aprobarLineaSchema.safeParse({ countId: 'c', itemId: 'i', confirmaUmbral: 'si' }).success)
check('>>> aplicar admite una nota corta; la aprobación masiva, un cursor opcional', aplicarConteoSchema.safeParse({ countId: 'c' }).success && aplicarConteoSchema.safeParse({ countId: 'c', note: 'Cierre de mes' }).success && !aplicarConteoSchema.safeParse({ countId: 'c', note: 'x'.repeat(121) }).success && aprobarSinAlertaSchema.safeParse({ countId: 'c' }).success && aprobarSinAlertaSchema.safeParse({ countId: 'c', cursor: 'abc' }).success && !aprobarSinAlertaSchema.safeParse({ cursor: 'abc' }).success)
check('>>> la revisión pagina de 1 a 200 (100 por defecto) y filtra por un estado válido', (() => { const r = revisionSchema.safeParse({ countId: 'c' }); return r.success && r.data.limite === 100 })() && revisionSchema.safeParse({ countId: 'c', limite: 200 }).success && !revisionSchema.safeParse({ countId: 'c', limite: 201 }).success && !revisionSchema.safeParse({ countId: 'c', limite: 0 }).success && revisionSchema.safeParse({ countId: 'c', estado: 'RECONTAR' }).success && !revisionSchema.safeParse({ countId: 'c', estado: 'OTRO' }).success)

console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
process.exit(fail === 0 ? 0 : 1)
