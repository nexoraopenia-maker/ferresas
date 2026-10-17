/**
 * Reporte: qué cambia si se endurece el redondeo a céntimos.
 *
 * NO modifica nada. Solo compara, sobre los mismos datos, el resultado del
 * redondeo actual y el del endurecido, y enumera dónde difieren.
 *
 * Correr con:  npx tsx scripts/reporte-redondeo.ts
 */

/** El de hoy, duplicado en sale-service, quote-service y PosTerminal. */
const centNaive = (n: number) => Math.round(n * 100) / 100

/** El endurecido, ya en uso en src/lib/dinero.ts y en la capa de impresión. */
const centDuro = (n: number) =>
  (n < 0 ? -1 : 1) * Math.round(Number((Math.abs(n) * 100).toFixed(4))) / 100

interface Linea { precio: number; cantidad: number; descuento: number; tasa: number }

/** Reproduce EXACTAMENTE la aritmética de registerSale con un redondeo dado. */
function calcular(lineas: Linea[], cent: (n: number) => number) {
  let subtotal = 0, taxTotal = 0, discountTotal = 0
  const detalle = lineas.map((l) => {
    const bruto = cent(l.precio * l.cantidad)
    const neto = cent(bruto - l.descuento)
    const base = cent(neto / (1 + l.tasa))
    const igv = cent(neto - base)
    subtotal = cent(subtotal + base)
    taxTotal = cent(taxTotal + igv)
    discountTotal = cent(discountTotal + l.descuento)
    return { bruto, neto, base, igv }
  })
  return { detalle, subtotal, taxTotal, discountTotal, total: cent(subtotal + taxTotal) }
}

// ── Precios reales de ferretería peruana, con IGV incluido ────────────────
const PRECIOS = [
  0.5, 0.8, 1, 1.2, 1.5, 2.5, 3.5, 4.2, 5, 6.5, 8.9, 9.9, 11.8, 12.5, 15,
  18.5, 22.9, 25, 28.5, 32.9, 35.5, 45.9, 52.5, 68, 89.9, 99.9, 120, 145.5,
  189, 249.9, 350, 480, 599, 850, 1250, 1899, 2500,
]
const CANTIDADES = [0.1, 0.25, 0.5, 1, 1.5, 2, 2.5, 3, 7, 10, 12.5, 25, 50, 100]
const TASAS = [0.18, 0]

interface Divergencia {
  caso: string
  campo: string
  hoy: number
  endurecido: number
  delta: number
}

const divergencias: Divergencia[] = []
let casos = 0

// ── 1. Línea única, barrido completo ──────────────────────────────────────
for (const precio of PRECIOS) {
  for (const cantidad of CANTIDADES) {
    for (const tasa of TASAS) {
      for (const descuento of [0, 0.5, 1, 2.5]) {
        const bruto = centNaive(precio * cantidad)
        if (descuento > bruto) continue
        casos++
        const lineas = [{ precio, cantidad, descuento, tasa }]
        const a = calcular(lineas, centNaive)
        const b = calcular(lineas, centDuro)
        const etq = `${cantidad} x S/${precio}${descuento ? ` - S/${descuento} dscto` : ''}, IGV ${tasa * 100}%`
        for (const campo of ['subtotal', 'taxTotal', 'total'] as const) {
          if (a[campo] !== b[campo]) {
            divergencias.push({
              caso: etq, campo,
              hoy: a[campo], endurecido: b[campo],
              delta: Number((b[campo] - a[campo]).toFixed(4)),
            })
          }
        }
      }
    }
  }
}

// ── 2. Carritos de varias líneas, donde el error se puede acumular ────────
let casosCarrito = 0
const divCarrito: Divergencia[] = []
for (let i = 0; i < PRECIOS.length; i++) {
  for (let j = 0; j < CANTIDADES.length; j++) {
    const lineas: Linea[] = [
      { precio: PRECIOS[i]!, cantidad: CANTIDADES[j]!, descuento: 0, tasa: 0.18 },
      { precio: PRECIOS[(i + 7) % PRECIOS.length]!, cantidad: CANTIDADES[(j + 3) % CANTIDADES.length]!, descuento: 0, tasa: 0.18 },
      { precio: PRECIOS[(i + 13) % PRECIOS.length]!, cantidad: CANTIDADES[(j + 5) % CANTIDADES.length]!, descuento: 0, tasa: 0 },
    ]
    casosCarrito++
    const a = calcular(lineas, centNaive)
    const b = calcular(lineas, centDuro)
    for (const campo of ['subtotal', 'taxTotal', 'total'] as const) {
      if (a[campo] !== b[campo]) {
        divCarrito.push({
          caso: `carrito 3 líneas (${PRECIOS[i]} x ${CANTIDADES[j]} + …)`,
          campo, hoy: a[campo], endurecido: b[campo],
          delta: Number((b[campo] - a[campo]).toFixed(4)),
        })
      }
    }
  }
}

// ── 3. Invariante que exige el UBL: la suma de líneas cuadra con el total ─
function comprobarInvarianteUBL(cent: (n: number) => number) {
  let fallos = 0
  const ejemplos: string[] = []
  for (const precio of PRECIOS) {
    for (const cantidad of CANTIDADES) {
      for (const tasa of TASAS) {
        const lineas = [{ precio, cantidad, descuento: 0, tasa }]
        const r = calcular(lineas, cent)
        const sumaNetos = r.detalle.reduce((s, d) => s + d.neto, 0)
        const sumaBases = r.detalle.reduce((s, d) => s + d.base, 0)
        const sumaIgv = r.detalle.reduce((s, d) => s + d.igv, 0)
        const ok =
          Math.abs(cent(sumaNetos) - r.total) < 1e-9 &&
          Math.abs(cent(sumaBases) - r.subtotal) < 1e-9 &&
          Math.abs(cent(sumaIgv) - r.taxTotal) < 1e-9 &&
          Math.abs(cent(r.subtotal + r.taxTotal) - r.total) < 1e-9
        if (!ok) {
          fallos++
          if (ejemplos.length < 3) ejemplos.push(`${cantidad} x S/${precio} @ ${tasa * 100}%`)
        }
      }
    }
  }
  return { fallos, ejemplos }
}

// ══ SALIDA ════════════════════════════════════════════════════════════════
const fmt = (n: number) => n.toFixed(2)

console.log('═'.repeat(74))
console.log('  REPORTE: endurecer el redondeo a céntimos')
console.log('═'.repeat(74))

console.log(`
  HOY         Math.round(n * 100) / 100
  ENDURECIDO  Math.round(Number((|n| * 100).toFixed(4))) / 100  ·  con signo

  La diferencia aparece cuando el valor exacto cae en medio céntimo y la
  representación binaria lo deja justo por debajo. Por ejemplo:

    0.145 * 100  =  ${(0.145 * 100).toString()}   →  hoy redondea a ${Math.round(0.145 * 100)}
    1.005 * 100  =  ${(1.005 * 100).toString()}   →  hoy redondea a ${Math.round(1.005 * 100)}
    2.675 * 100  =  ${(2.675 * 100).toString()}   →  hoy redondea a ${Math.round(2.675 * 100)}
`)

console.log('─'.repeat(74))
console.log(`  1) LÍNEA ÚNICA — ${casos.toLocaleString('es-PE')} combinaciones`)
console.log('─'.repeat(74))
if (divergencias.length === 0) {
  console.log('\n  Ningún importe cambia.\n')
} else {
  console.log(`\n  ${divergencias.length} divergencias:\n`)
  console.log('  caso                                        campo      hoy  endurec.   delta')
  for (const d of divergencias.slice(0, 40)) {
    console.log(
      `  ${d.caso.padEnd(42)} ${d.campo.padEnd(9)} ${fmt(d.hoy).padStart(6)} ${fmt(d.endurecido).padStart(9)} ${d.delta >= 0 ? '+' : ''}${d.delta.toFixed(2)}`,
    )
  }
  if (divergencias.length > 40) console.log(`  … y ${divergencias.length - 40} más`)
  const maxDelta = Math.max(...divergencias.map((d) => Math.abs(d.delta)))
  console.log(`\n  Desviación máxima: S/ ${maxDelta.toFixed(2)}`)
}

console.log('─'.repeat(74))
console.log(`  2) CARRITOS DE 3 LÍNEAS — ${casosCarrito.toLocaleString('es-PE')} combinaciones`)
console.log('─'.repeat(74))
if (divCarrito.length === 0) {
  console.log('\n  Ningún importe cambia.\n')
} else {
  console.log(`\n  ${divCarrito.length} divergencias:\n`)
  for (const d of divCarrito.slice(0, 20)) {
    console.log(
      `  ${d.caso.padEnd(42)} ${d.campo.padEnd(9)} ${fmt(d.hoy).padStart(6)} ${fmt(d.endurecido).padStart(9)} ${d.delta >= 0 ? '+' : ''}${d.delta.toFixed(2)}`,
    )
  }
  if (divCarrito.length > 20) console.log(`  … y ${divCarrito.length - 20} más`)
}

console.log('─'.repeat(74))
console.log('  3) INVARIANTE DEL UBL: suma de líneas = totales del documento')
console.log('─'.repeat(74))
const invHoy = comprobarInvarianteUBL(centNaive)
const invDuro = comprobarInvarianteUBL(centDuro)
console.log(`
  Con el redondeo de HOY:        ${invHoy.fallos} incumplimientos`)
if (invHoy.ejemplos.length) console.log(`     ejemplos: ${invHoy.ejemplos.join(' · ')}`)
console.log(`  Con el redondeo ENDURECIDO:    ${invDuro.fallos} incumplimientos`)
if (invDuro.ejemplos.length) console.log(`     ejemplos: ${invDuro.ejemplos.join(' · ')}`)

console.log('\n' + '═'.repeat(74))

// ══ 4. BÚSQUEDA ADVERSARIA ════════════════════════════════════════════════
//
// Las secciones 1 y 2 no encontraron ni una divergencia, pero eso puede ser
// que el barrido no incluya los casos malos. Aquí se buscan A PROPÓSITO:
// entradas en las que el valor exacto cae justo en medio céntimo, que es el
// único sitio donde los dos redondeos difieren.

console.log('─'.repeat(74))
console.log('  4) BÚSQUEDA ADVERSARIA: ¿existen esos casos con datos realistas?')
console.log('─'.repeat(74))

/** ¿Difieren los dos redondeos para este valor? */
const difieren = (n: number) => centNaive(n) !== centDuro(n)

// 4a. Sobre el producto precio * cantidad.
const hallazgosProducto: string[] = []
for (let centimos = 1; centimos <= 300_00; centimos++) {
  const precio = centimos / 100 // siempre 2 decimales exactos
  for (const cantidad of [
    0.001, 0.005, 0.01, 0.05, 0.1, 0.125, 0.15, 0.2, 0.25, 0.3, 0.333, 0.5,
    0.67, 0.75, 1.5, 2.5, 3.5, 7.5, 12.5, 1.005, 0.015,
  ]) {
    const bruto = precio * cantidad
    if (difieren(bruto)) {
      hallazgosProducto.push(
        `${cantidad} x S/${precio.toFixed(2)} = ${bruto} → hoy ${centNaive(bruto).toFixed(2)}, endurecido ${centDuro(bruto).toFixed(2)}`,
      )
      if (hallazgosProducto.length >= 8) break
    }
  }
  if (hallazgosProducto.length >= 8) break
}

console.log(`\n  4a) En el producto precio x cantidad: ${hallazgosProducto.length > 0 ? 'SÍ existen' : 'no se encontró ninguno'}`)
for (const h of hallazgosProducto) console.log(`      · ${h}`)

// 4b. Sobre la extracción de la base imponible: neto / 1.18.
const hallazgosBase: string[] = []
for (let centimos = 1; centimos <= 500_00; centimos++) {
  const neto = centimos / 100
  const base = neto / 1.18
  if (difieren(base)) {
    hallazgosBase.push(
      `neto S/${neto.toFixed(2)} / 1.18 = ${base} → base hoy ${centNaive(base).toFixed(2)}, endurecida ${centDuro(base).toFixed(2)}`,
    )
    if (hallazgosBase.length >= 8) break
  }
}

console.log(`\n  4b) Al extraer la base imponible (neto / 1.18): ${hallazgosBase.length > 0 ? 'SÍ existen' : 'no se encontró ninguno en 50 000 netos'}`)
for (const h of hallazgosBase) console.log(`      · ${h}`)

// 4c. Si 4a encontró casos, ¿qué le pasa al documento completo?
if (hallazgosProducto.length > 0) {
  console.log('\n  4c) Impacto en el documento con el primer caso encontrado:')
  const m = hallazgosProducto[0]!.match(/^([\d.]+) x S\/([\d.]+)/)
  if (m) {
    const cantidad = Number(m[1]), precio = Number(m[2])
    const lineas = [{ precio, cantidad, descuento: 0, tasa: 0.18 }]
    const a = calcular(lineas, centNaive)
    const b = calcular(lineas, centDuro)
    console.log(`      ${cantidad} x S/${precio.toFixed(2)} al 18%`)
    console.log(`      campo       hoy   endurecido   delta`)
    for (const c of ['subtotal', 'taxTotal', 'total'] as const) {
      const d = b[c] - a[c]
      console.log(`      ${c.padEnd(10)} ${a[c].toFixed(2).padStart(6)} ${b[c].toFixed(2).padStart(11)} ${(d >= 0 ? '+' : '') + d.toFixed(2)}`)
    }
  }
}

console.log('\n' + '═'.repeat(74))

// ══ 5. LOS IMPORTES CONCRETOS QUE AFIRMA LA SUITE ═════════════════════════
//
// Las secciones anteriores barren el espacio. Esta comprueba exactamente los
// pares (precio, cantidad) que usan los ficheros de prueba, que son los
// importes que hoy están escritos como valor esperado en una aserción.

console.log('─'.repeat(74))
console.log('  5) LOS IMPORTES QUE LA SUITE AFIRMA HOY')
console.log('─'.repeat(74))

const FIXTURES: [number, number, number, string][] = [
  // precio, cantidad, tasa, de dónde sale
  [11.8, 10, 0.18, 'pos-invoicing: tubo PVC'],
  [11.8, 1, 0.18, 'pos-invoicing'],
  [4.2, 2.5, 0.18, 'printing: cable THW'],
  [4.2, 10, 0.18, 'printing: cotización'],
  [4.2, 12.5, 0.18, 'smoke: cable a granel'],
  [25, 1, 0, 'printing: libro exonerado'],
  [32.9, 1, 0.18, 'branches: cemento'],
  [32.9, 2, 0.18, 'branches: caja'],
  [32.9, 3, 0.18, 'smoke: cemento'],
  [32.9, 4, 0.18, 'smoke: cemento'],
  [32.9, 50, 0.18, 'branches: cotización'],
  [25, 1, 0.18, 'branches: fierro'],
  [6.5, 12.5, 0, 'branches: clavos a granel'],
  [0.25, 4, 0.18, 'quantities: a granel'],
  [1.5, 0.5, 0.18, 'quantities: media unidad'],
]

let cambian = 0
console.log('\n  precio   cant.  IGV   total hoy  endurecido  ¿cambia?  origen')
for (const [precio, cantidad, tasa, origen] of FIXTURES) {
  const lineas = [{ precio, cantidad, descuento: 0, tasa }]
  const a = calcular(lineas, centNaive)
  const b = calcular(lineas, centDuro)
  const cambia = a.total !== b.total || a.subtotal !== b.subtotal || a.taxTotal !== b.taxTotal
  if (cambia) cambian++
  console.log(
    `  ${precio.toFixed(2).padStart(6)} ${String(cantidad).padStart(6)} ${String(tasa * 100).padStart(4)}% ` +
      `${a.total.toFixed(2).padStart(10)} ${b.total.toFixed(2).padStart(11)}  ${(cambia ? 'SÍ' : 'no').padEnd(8)}  ${origen}`,
  )
}
console.log(`\n  ${cambian} de ${FIXTURES.length} importes de la suite cambiarían.`)
console.log('\n' + '═'.repeat(74))
