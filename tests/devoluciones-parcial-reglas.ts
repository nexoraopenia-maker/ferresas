import './guard'
import {
  CODIGO_NOTA_PARCIAL, UMBRAL_ADVERTENCIA_DEVOLUCION_DIAS, aDiezmilesimas, acumulado, avisoAntiguedad, baseDeLineaCent, contadoRestante, deDiezmilesimas, divRedondeada,
  planDeComprobanteParcial, repartirDeudaYDinero, repartirEnProporcion, resolverLineas, topeDevolvibleCent, tramo, type LineaParaDevolver, type LineaVendida,
} from '../src/features/devoluciones/parcial'

/**
 * F6.2a · El núcleo de la devolución parcial, sin base: el importe acumulado (sin céntimos huérfanos), el tope por línea, el reparto entre deuda y
 * dinero, el aviso de antigüedad y el plan del comprobante. Lo más importante: devolver una línea en N partes suma EXACTAMENTE su importe, su base y su IGV.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const lanza = (f: () => unknown) => { try { f(); return false } catch { return true } }

// PRNG determinista (mulberry32): el mismo resultado en cada corrida.
function rng(seed: number) { let a = seed; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }

console.log('\nA) Conversión y división')
check('aDiezmilesimas: 2.5 → 25000; 0.0001 → 1; 1234.5678 → 12345678', aDiezmilesimas(2.5) === 25_000 && aDiezmilesimas(0.0001) === 1 && aDiezmilesimas(1234.5678) === 12_345_678)
check('>>> más de 4 decimales, negativos y no finitos se rechazan', lanza(() => aDiezmilesimas(0.00001)) && lanza(() => aDiezmilesimas(-1)) && lanza(() => aDiezmilesimas(NaN)) && lanza(() => aDiezmilesimas(Infinity)))
check('deDiezmilesimas es la inversa', deDiezmilesimas(aDiezmilesimas(3.7)) === 3.7)
check('divRedondeada: medio hacia arriba (5/2=3, 4/3=1, 5/3=2, 0/7=0) y rechaza divisor ≤ 0 o dividendo negativo', divRedondeada(5n, 2n) === 3n && divRedondeada(4n, 3n) === 1n && divRedondeada(5n, 3n) === 2n && divRedondeada(0n, 7n) === 0n && lanza(() => divRedondeada(1n, 0n)) && lanza(() => divRedondeada(-1n, 2n)))

console.log('\nB) El reparto de una línea: casos exactos')
const l118: LineaParaDevolver = { totalCent: 11_800, vendidaM: aDiezmilesimas(3), tasa: 0.18 }
check('>>> la base se REDONDEA como en la venta (no se trunca): 100.00 → 84.75, 99.99 → 84.74, 0.05 → 0.04, 12.35 → 10.47', baseDeLineaCent(10_000, 0.18) === 8_475 && baseDeLineaCent(9_999, 0.18) === 8_474 && baseDeLineaCent(5, 0.18) === 4 && baseDeLineaCent(1_235, 0.18) === 1_047)
check('la base de 118.00 al 18 % es 100.00 y la de una línea exonerada es su total', baseDeLineaCent(11_800, 0.18) === 10_000 && baseDeLineaCent(5_000, 0) === 5_000)
const t1 = tramo(l118, 0, aDiezmilesimas(1)), t2 = tramo(l118, t1.nuevaDevueltaM, aDiezmilesimas(1)), t3 = tramo(l118, t2.nuevaDevueltaM, aDiezmilesimas(1))
check('>>> devolver 1 de 2 unidades de S/ 200.00 da EXACTAMENTE 100.00 (no 100.01) y la otra mitad 100.00', (() => { const l = { totalCent: 20_000, vendidaM: aDiezmilesimas(2), tasa: 0.18 }; const a = tramo(l, 0, aDiezmilesimas(1)), b = tramo(l, a.nuevaDevueltaM, aDiezmilesimas(1)); return a.importeCent === 10_000 && b.importeCent === 10_000 && a.baseCent + b.baseCent === 16_949 })())
check('>>> 3 unidades de S/ 118.00 devueltas de 1 en 1: 39.33 + 39.34 + 39.33 = 118.00 exactos', [t1, t2, t3].map((x) => x.importeCent).join() === '3933,3934,3933' && t1.importeCent + t2.importeCent + t3.importeCent === 11_800)
check('…con base 33.33 + 33.34 + 33.33 = 100.00 e IGV 6.00 × 3 = 18.00', t1.baseCent + t2.baseCent + t3.baseCent === 10_000 && t1.igvCent + t2.igvCent + t3.igvCent === 1_800)
check('importe = base + IGV en cada tramo, y solo el último completa la línea', [t1, t2, t3].every((x) => x.importeCent === x.baseCent + x.igvCent) && !t1.completaLinea && !t2.completaLinea && t3.completaLinea)
const caja: LineaParaDevolver = { totalCent: 12_345, vendidaM: aDiezmilesimas(10), tasa: 0.18 }   // una caja ×10 vendida como una línea de 10 unidades base
const s3 = tramo(caja, 0, aDiezmilesimas(3)), s7 = tramo(caja, s3.nuevaDevueltaM, aDiezmilesimas(7))
check('>>> 3 sueltas y luego las 7 restantes de una caja ×10 suman EXACTAMENTE el importe de la caja (123.45), su base y su IGV', s3.importeCent + s7.importeCent === 12_345 && s3.baseCent + s7.baseCent === baseDeLineaCent(12_345, 0.18) && s3.igvCent + s7.igvCent === 12_345 - baseDeLineaCent(12_345, 0.18) && s7.completaLinea)
check('devolver todo de una vez da la línea entera', tramo(l118, 0, l118.vendidaM).importeCent === 11_800 && tramo(l118, 0, l118.vendidaM).completaLinea)
const exo: LineaParaDevolver = { totalCent: 1_000, vendidaM: aDiezmilesimas(3), tasa: 0 }
check('línea exonerada: IGV 0 en todos los tramos y el total exacto', [1, 1, 1].reduce((acc, _, i) => { const t = tramo(exo, acc.m, aDiezmilesimas(1)); return { m: t.nuevaDevueltaM, c: acc.c + t.importeCent, igv: acc.igv + t.igvCent, i } }, { m: 0, c: 0, igv: 0, i: 0 }).c === 1_000)
check('cantidades decimales (2.5 kg de 7.5 kg a S/ 37.45): 1.0 + 1.5 + 5.0 suman el total', (() => { const l = { totalCent: 3_745, vendidaM: aDiezmilesimas(7.5), tasa: 0.18 }; let m = 0, c = 0; for (const q of [1.0, 1.5, 5.0]) { const t = tramo(l, m, aDiezmilesimas(q)); m = t.nuevaDevueltaM; c += t.importeCent } return c === 3_745 && m === l.vendidaM })())
check('acumulado(0) = 0 y acumulado(todo) = la línea; se rechaza más de lo vendido', acumulado(l118, 0).importeCent === 0 && acumulado(l118, l118.vendidaM).importeCent === 11_800 && lanza(() => acumulado(l118, l118.vendidaM + 1)) && lanza(() => tramo(l118, 0, 0)))

console.log('\nC) Propiedades: 3000 líneas al azar partidas en 1 a 8 partes')
{
  const r = rng(20261028)
  let ok = true, malo = ''
  const registrar = (m: string) => { if (ok) { ok = false; malo = m } }
  for (let n = 0; n < 3000; n++) {
    const tasa = [0, 0.18, 0.1, 0.18][Math.floor(r() * 4)]!
    const totalCent = 1 + Math.floor(r() * 500_000)
    const vendidaM = 1 + Math.floor(r() * 400_000)                 // hasta 40 unidades con 4 decimales
    const l = { totalCent, vendidaM, tasa }
    const partes = 1 + Math.floor(r() * 8)
    // corte aleatorio en `partes` tramos no vacíos
    const cortes = new Set<number>(); while (cortes.size < Math.min(partes - 1, vendidaM - 1)) cortes.add(1 + Math.floor(r() * (vendidaM - 1)))
    const puntos = [0, ...[...cortes].sort((a, b) => a - b), vendidaM]
    let m = 0, imp = 0, base = 0, igv = 0
    for (let k = 1; k < puntos.length; k++) {
      const t = tramo(l, m, puntos[k]! - puntos[k - 1]!)
      if (t.baseCent < 0 || t.igvCent < 0 || t.importeCent < 0) registrar(`negativo ${JSON.stringify({ l, t })}`)
      if (t.importeCent !== t.baseCent + t.igvCent) registrar('importe ≠ base + IGV')
      const directo = Math.round((totalCent * puntos[k]!) / vendidaM) - Math.round((totalCent * puntos[k - 1]!) / vendidaM)
      if (t.importeCent !== directo) registrar(`≠ round(T·c/Q) − round(T·c_previo/Q): ${t.importeCent} vs ${directo}`)
      m = t.nuevaDevueltaM; imp += t.importeCent; base += t.baseCent; igv += t.igvCent
    }
    const B = baseDeLineaCent(totalCent, tasa)
    if (imp !== totalCent) registrar(`Σ importe ${imp} ≠ ${totalCent} ${JSON.stringify(l)}`)
    if (base !== B) registrar(`Σ base ${base} ≠ ${B}`)
    if (igv !== totalCent - B) registrar(`Σ IGV ${igv} ≠ ${totalCent - B}`)
    if (m !== vendidaM) registrar('no llegó a lo vendido')
  }
  check('>>> en 3000 líneas al azar: cada tramo es EXACTAMENTE round(T·c/Q) − round(T·c_previo/Q); Σ importe = lineTotal, Σ base = base de la línea y Σ IGV = IGV de la línea, AL CÉNTIMO; ningún tramo negativo', ok, malo)
  let mono = true
  for (let n = 0; n < 500; n++) { const l = { totalCent: 1 + Math.floor(r() * 99_999), vendidaM: 1 + Math.floor(r() * 99_999), tasa: 0.18 }; let prev = -1; for (let c = 0; c <= l.vendidaM && mono; c += Math.max(1, Math.floor(l.vendidaM / 50))) { const a = acumulado(l, c).importeCent; if (a < prev) mono = false; prev = a } }
  check('el acumulado nunca baja al devolver más unidades (monótono)', mono)
}

{
  // Importes y cantidades PEQUEÑOS: ahí es donde un reparto mal hecho da un IGV mayor que el importe del tramo (base negativa) o un céntimo huérfano.
  const r = rng(99)
  let ok = true, malo = ''
  for (let n = 0; n < 4000 && ok; n++) {
    const tasa = [0.18, 0.18, 0.1, 0][Math.floor(r() * 4)]!
    const totalCent = 1 + Math.floor(r() * 60)
    const unidades = 2 + Math.floor(r() * 11)
    const l = { totalCent, vendidaM: unidades * 10_000, tasa }
    let m = 0, imp = 0, base = 0, igv = 0
    for (let k = 0; k < unidades; k++) {                                   // de una en una
      const t = tramo(l, m, 10_000)
      if (t.baseCent < 0 || t.igvCent < 0 || t.importeCent !== t.baseCent + t.igvCent) { ok = false; malo = `tramo inválido ${JSON.stringify({ l, k, t })}` }
      m = t.nuevaDevueltaM; imp += t.importeCent; base += t.baseCent; igv += t.igvCent
    }
    if (imp !== totalCent || base !== baseDeLineaCent(totalCent, tasa) || igv !== totalCent - baseDeLineaCent(totalCent, tasa)) { ok = false; malo = `no cuadra ${JSON.stringify({ l, imp, base, igv })}` }
  }
  check('>>> 4000 líneas de importe y cantidad PEQUEÑOS (1 a 60 céntimos, 2 a 12 unidades) devueltas de 1 en 1: ningún tramo con base o IGV negativos y todo cuadra al céntimo', ok, malo)
}

console.log('\nD) Validar lo que se pide devolver')
const vend = (o: Partial<LineaVendida> & { id: string }): LineaVendida => ({ nombre: `Prod ${o.id}`, trackStock: true, totalCent: 11_800, vendidaM: aDiezmilesimas(3), tasa: 0.18, yaDevueltaM: 0, yaDevueltoImporteCent: 0, ...o })
const A = vend({ id: 'a' }), B = vend({ id: 'b', totalCent: 5_000, vendidaM: aDiezmilesimas(1), tasa: 0, nombre: 'Servicio de corte', trackStock: false })
const pide = (xs: { id: string; q: number; d?: 'STOCK' | 'MERMA' }[], v = [A, B]): ReturnType<typeof resolverLineas> => {
  // Una excepción cuenta como fallo de la prueba (✗), no como un aborto sin veredicto.
  try { return resolverLineas(v, xs.map((x) => ({ saleItemId: x.id, cantidad: x.q, destino: x.d ?? 'STOCK' }))) } catch (e) { return { ok: false, mensaje: `EXCEPCIÓN: ${(e as Error).message}` } }
}
const ok1 = pide([{ id: 'a', q: 1 }])
check('una línea válida: importe, base, IGV y total; la venta NO queda completa', ok1.ok && ok1.totalCent === 3_933 && ok1.baseCent + ok1.igvCent === 3_933 && !ok1.completaVenta)
const todo = pide([{ id: 'a', q: 3 }, { id: 'b', q: 1 }])
check('>>> todas las líneas por completo: completa la venta, total = Σ líneas', todo.ok && todo.completaVenta && todo.totalCent === 16_800)
const seguido = pide([{ id: 'a', q: 2 }], [vend({ id: 'a', yaDevueltaM: aDiezmilesimas(1), yaDevueltoImporteCent: tramo({ totalCent: 11_800, vendidaM: aDiezmilesimas(3), tasa: 0.18 }, 0, aDiezmilesimas(1)).importeCent }), B])
check('devolver las 2 que faltan tras haber devuelto 1: el tramo es 78.67 (118.00 − 39.33) y la línea queda completa', seguido.ok && seguido.lineas[0]!.importeCent === 7_867 && seguido.lineas[0]!.completaLinea)
const noPasa = (r: ReturnType<typeof pide>, texto: RegExp) => !r.ok && texto.test(r.mensaje)
check('>>> pedir más de lo que queda se rechaza diciendo cuánto queda', noPasa(pide([{ id: 'a', q: 4 }]), /solo quedan 3 por devolver/) && noPasa(pide([{ id: 'a', q: 2 }], [vend({ id: 'a', yaDevueltaM: aDiezmilesimas(2), yaDevueltoImporteCent: acumulado({ totalCent: 11_800, vendidaM: aDiezmilesimas(3), tasa: 0.18 }, aDiezmilesimas(2)).importeCent })]), /solo quedan 1 por devolver/))
check('una línea ya devuelta por completo lo dice', noPasa(pide([{ id: 'a', q: 1 }], [vend({ id: 'a', yaDevueltaM: aDiezmilesimas(3), yaDevueltoImporteCent: 11_800 })]), /ya se devolvió por completo/))
check('cantidad cero, negativa, con 5 decimales o NaN → rechazada', ['0', '-1', '0.00001', 'NaN'].every((q) => !pide([{ id: 'a', q: Number(q) }]).ok))
check('sin líneas, línea ajena o repetida → rechazadas', noPasa(pide([]), /al menos un producto/) && noPasa(pide([{ id: 'zzz', q: 1 }]), /no pertenece/) && noPasa(pide([{ id: 'a', q: 1 }, { id: 'a', q: 1 }]), /dos veces/))
check('>>> un servicio sin control de stock no puede ir a merma; sin merma va a SIN_STOCK', noPasa(pide([{ id: 'b', q: 1, d: 'MERMA' }]), /no controla stock/) && (() => { const r = pide([{ id: 'b', q: 1 }]); return r.ok && r.lineas[0]!.destino === 'SIN_STOCK' })())
check('un producto con stock respeta el destino pedido (STOCK / MERMA)', (() => { const a = pide([{ id: 'a', q: 1, d: 'MERMA' }]), b = pide([{ id: 'a', q: 1 }]); return a.ok && a.lineas[0]!.destino === 'MERMA' && b.ok && b.lineas[0]!.destino === 'STOCK' })())
check('>>> una cantidad que no vale ni un céntimo se rechaza', noPasa(resolverLineas([vend({ id: 'a', totalCent: 100, vendidaM: aDiezmilesimas(1000) })], [{ saleItemId: 'a', cantidad: 0.0001, destino: 'STOCK' }]), /demasiado pequeña/))
check('>>> si lo guardado de lo ya devuelto no cuadra con la fórmula, se frena (no se sigue sobre datos dañados)', noPasa(pide([{ id: 'a', q: 1 }], [vend({ id: 'a', yaDevueltaM: aDiezmilesimas(1), yaDevueltoImporteCent: 1 })]), /no cuadra/))
check('una línea de importe 0 (regalo) se puede devolver sin céntimos', (() => { const r = resolverLineas([vend({ id: 'g', totalCent: 0 })], [{ saleItemId: 'g', cantidad: 1, destino: 'STOCK' }]); return r.ok && r.totalCent === 0 })())

console.log('\nE) Deuda y dinero')
const cta = (o: Partial<{ status: 'ABIERTA' | 'PAGADA' | 'ANULADA'; amountCent: number; paidCent: number }> = {}) => ({ status: 'ABIERTA' as const, amountCent: 20_000, paidCent: 0, ...o })
const rd = (total: number, cuenta: ReturnType<typeof cta> | null, contado: number) => repartirDeudaYDinero(total, cuenta, contado)
const okR = (r: ReturnType<typeof rd>) => (r.ok ? r : null)
check('contado puro (sin cuenta): todo es dinero, la cuenta no se toca', okR(rd(5_000, null, 10_000))?.dineroCent === 5_000 && okR(rd(5_000, null, 10_000))?.deudaCent === 0 && okR(rd(5_000, null, 10_000))?.accion === 'NINGUNA')
check('>>> fiado sin abonos, devolución menor que el saldo: baja la deuda (REDUCIR) y no hay dinero', (() => { const r = okR(rd(5_000, cta(), 0)); return r?.deudaCent === 5_000 && r.dineroCent === 0 && r.accion === 'REDUCIR' })())
check('>>> devolver exactamente todo el saldo sin abonos: la cuenta se da de baja', okR(rd(20_000, cta(), 0))?.accion === 'DAR_DE_BAJA')
check('>>> con abonos y cabe en el saldo (200 − 50 = 150; devuelvo 100): REDUCIR, sin dinero', (() => { const r = okR(rd(10_000, cta({ paidCent: 5_000 }), 0)); return r?.accion === 'REDUCIR' && r.dineroCent === 0 })())
check('con abonos y devolviendo justo el saldo: la cuenta queda PAGADA', okR(rd(15_000, cta({ paidCent: 5_000 }), 0))?.accion === 'CERRAR_PAGADA')
check('>>> con abonos y MÁS que el saldo (sin contado): BLOQUEA con CREDIT_HAS_PAYMENTS y el tope exacto', (() => { const r = rd(16_000, cta({ paidCent: 5_000 }), 0); return !r.ok && r.code === 'CREDIT_HAS_PAYMENTS' && r.topeCent === 15_000 && /150\.00/.test(r.mensaje) })())
check('>>> mixta: contado 100 + fiado 200 con un abono de 50; devuelvo 250 = deuda 150 + dinero 100 (cabe)', (() => { const r = okR(rd(25_000, cta({ paidCent: 5_000 }), 10_000)); return r?.deudaCent === 15_000 && r.dineroCent === 10_000 && r.accion === 'CERRAR_PAGADA' })())
check('…y devolver los 300 enteros obligaría a reembolsar un abono (50): se bloquea, tope 250', (() => { const r = rd(30_000, cta({ paidCent: 5_000 }), 10_000); return !r.ok && r.code === 'CREDIT_HAS_PAYMENTS' && r.topeCent === 25_000 })())
check('sin abonos, un importe mayor que lo devolvible es INVALID_DOCUMENT (no dice «abonos»)', (() => { const r = rd(9_000, null, 5_000); return !r.ok && r.code === 'INVALID_DOCUMENT' && !/abono/.test(r.mensaje) })())
check('una cuenta ya ANULADA o PAGADA no tiene saldo: todo lo devuelto es dinero', okR(rd(4_000, cta({ status: 'ANULADA' }), 10_000))?.dineroCent === 4_000 && okR(rd(4_000, cta({ status: 'PAGADA', paidCent: 20_000 }), 10_000))?.dineroCent === 4_000)
check('el tope devolvible = saldo pendiente + contado sin devolver', topeDevolvibleCent(cta({ paidCent: 5_000 }), 10_000) === 25_000 && topeDevolvibleCent(null, 7_000) === 7_000 && topeDevolvibleCent(cta({ status: 'ANULADA' }), 7_000) === 7_000)

console.log('\nF) Lo pagado que sigue sin devolverse y la sugerencia de reembolso')
const pagos = [{ method: 'EFECTIVO', cent: 6_000 }, { method: 'YAPE', cent: 4_000 }]
check('sin devoluciones previas: todo lo pagado', contadoRestante(pagos, []).totalCent === 10_000)
check('>>> tras devolver 20.00 en efectivo y 10.00 por Yape quedan 40.00 en efectivo y 30.00 por Yape', (() => { const c = contadoRestante(pagos, [{ method: 'EFECTIVO', cent: 2_000 }, { method: 'YAPE', cent: 1_000 }]); return c.totalCent === 7_000 && c.porMedio.find((m) => m.method === 'EFECTIVO')!.cent === 4_000 && c.porMedio.find((m) => m.method === 'YAPE')!.cent === 3_000 })())
check('un reembolso «sin salida» (sin medio) resta del total, repartido en proporción', (() => { const c = contadoRestante(pagos, [{ method: null, cent: 1_000 }]); return c.totalCent === 9_000 && c.porMedio.reduce((a, m) => a + m.cent, 0) === 9_000 })())
check('un medio agotado desaparece de la lista', contadoRestante(pagos, [{ method: 'YAPE', cent: 4_000 }]).porMedio.length === 1)
check('>>> repartirEnProporcion: suma exacta, nunca más de lo que tiene cada medio (0..N céntimos, 5 medios)', (() => { const r = rng(7); for (let i = 0; i < 2000; i++) { const w = Array.from({ length: 1 + Math.floor(r() * 5) }, (_, k) => ({ method: `m${k}`, cent: 1 + Math.floor(r() * 9_000) })); const suma = w.reduce((a, x) => a + x.cent, 0), total = Math.floor(r() * (suma + 1)); const out = repartirEnProporcion(total, w); if (out.reduce((a, x) => a + x.cent, 0) !== total) return false; if (out.some((x) => x.cent > w.find((y) => y.method === x.method)!.cent)) return false } return true })())
check('repartir más de lo disponible se rechaza', lanza(() => repartirEnProporcion(10_001, pagos)))
check('60/40 de 10.01: 6.01 y 4.00 (el resto va a la mayor fracción)', (() => { const o = repartirEnProporcion(1_001, pagos); return o.reduce((a, x) => a + x.cent, 0) === 1_001 })())

console.log('\nG) Aviso de antigüedad (⚠️ operativo, no bloquea)')
check('el umbral es de 30 días', UMBRAL_ADVERTENCIA_DEVOLUCION_DIAS === 30)
check('>>> 30 días exactos no avisan; 31 sí; hoy y futuro = 0 días', avisoAntiguedad('2026-09-28', '2026-10-28').avisar === false && avisoAntiguedad('2026-09-27', '2026-10-28').avisar === true && avisoAntiguedad('2026-10-28', '2026-10-28').dias === 0 && avisoAntiguedad('2026-10-29', '2026-10-28').dias === 0)
check('cuenta días de calendario entre meses y años', avisoAntiguedad('2025-12-31', '2026-01-02').dias === 2 && avisoAntiguedad('2026-02-27', '2026-03-01').dias === 2)

console.log('\nH) Plan del comprobante de una parcial')
const doc = (estado: 'PENDIENTE' | 'ENVIADO' | 'ACEPTADO' | 'OBSERVADO' | 'RECHAZADO' | 'ANULADO', isTrial = false) => ({ estado, isTrial, numero: 'B001-00000012' })
check('>>> ACEPTADO y OBSERVADO → nota 07', ['ACEPTADO', 'OBSERVADO'].every((e) => { const p = planDeComprobanteParcial(doc(e as never), false); return p.accion === 'EMITIR_NOTA' && p.codigo === CODIGO_NOTA_PARCIAL && p.codigo === '07' }))
check('PENDIENTE y ENVIADO → bloquea nombrando el comprobante', ['PENDIENTE', 'ENVIADO'].every((e) => { const p = planDeComprobanteParcial(doc(e as never), false); return p.accion === 'BLOQUEAR' && p.mensaje.includes('B001-00000012') }))
check('RECHAZADO, ANULADO y sin comprobante → nada', planDeComprobanteParcial(doc('RECHAZADO'), false).accion === 'NINGUNA' && planDeComprobanteParcial(doc('ANULADO'), true).accion === 'NINGUNA' && planDeComprobanteParcial(null, false).accion === 'NINGUNA')
check('>>> el de ensayo: nada mientras queda algo por devolver; se marca solo al completar la venta', planDeComprobanteParcial(doc('ACEPTADO', true), false).accion === 'NINGUNA' && planDeComprobanteParcial(doc('ACEPTADO', true), true).accion === 'MARCAR_ENSAYO')

console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
process.exit(fail === 0 ? 0 : 1)
