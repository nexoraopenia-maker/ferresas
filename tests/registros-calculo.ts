import { registroCompras, registroVentas, type CompraRegistrable, type ComprobanteVenta } from '../src/features/registros/registro-calculo'
import { csvRegistroCompras, csvRegistroVentas } from '../src/features/registros/registro-csv'
import { generarCsv } from '../src/lib/csv-export'

/**
 * F5.4 · Registros de ventas y de compras (funciones puras). Lo central: los totales suman SOLO aceptados y observados, las notas de crédito
 * restan, lo demás va al bloque de control, las compras sin documento usan la recepción como fecha PROVISIONAL, y todo cuadra al céntimo.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
let semilla = 11
const rnd = () => { semilla = (semilla * 1103515245 + 12345) % 2147483648; return semilla / 2147483648 }
const V = (id: string, o: Partial<ComprobanteVenta> = {}): ComprobanteVenta => ({
  id, fecha: '2026-10-20', tipo: 'FACTURA', numero: `F001-${id.padStart(8, '0')}`, relacionado: null, receptorTipo: 'RUC', receptorNumero: '20123456789', receptorNombre: 'Cliente SAC',
  moneda: 'PEN', base: 100, igv: 18, total: 118, estado: 'ACEPTADO', ...o,
})

console.log('\nA) Registro de ventas: qué suma')
const r1 = registroVentas([V('1'), V('2', { estado: 'OBSERVADO' }), V('3', { estado: 'PENDIENTE' }), V('4', { estado: 'ENVIADO' }), V('5', { estado: 'RECHAZADO' }), V('6', { estado: 'ANULADO' })])
check('>>> los totales suman SOLO aceptados y observados (2 documentos: 236.00)', r1.totales.documentos === 2 && r1.totales.total === 236 && r1.totales.base === 200 && r1.totales.igv === 36)
check('>>> pendientes, enviados, rechazados y anulados NO suman: van al control, cada uno con su conteo e importe', r1.control.map((k) => `${k.estado}:${k.documentos}:${k.total}`).join() === 'PENDIENTE:1:118,ENVIADO:1:118,RECHAZADO:1:118,ANULADO:1:118')
check('todas las filas aparecen (6), las que no suman marcadas', r1.filas.length === 6 && r1.filas.filter((f) => f.suma).length === 2)
const r2 = registroVentas([V('1'), V('2', { tipo: 'NOTA_CREDITO', numero: 'FC01-00000001', relacionado: 'F001-00000001', base: 50, igv: 9, total: 59 }), V('3', { tipo: 'NOTA_DEBITO', numero: 'FD01-00000001', base: 10, igv: 1.8, total: 11.8 })])
check('>>> la nota de crédito RESTA y la de débito suma: 118 − 59 + 11.80 = 70.80', r2.totales.total === 70.8 && r2.totales.base === 60 && r2.totales.igv === 10.8)
check('en las filas la nota de crédito lleva signo −1 y conserva su comprobante relacionado', r2.filas.find((f) => f.tipo === 'NOTA_CREDITO')!.signo === -1 && r2.filas.find((f) => f.tipo === 'NOTA_CREDITO')!.relacionado === 'F001-00000001')
check('>>> una nota de crédito PENDIENTE no resta todavía: va al control con signo negativo', (() => { const r = registroVentas([V('1'), V('2', { tipo: 'NOTA_CREDITO', estado: 'PENDIENTE' })]); return r.totales.total === 118 && r.control.find((k) => k.estado === 'PENDIENTE')!.total === -118 })())
check('por tipo: facturas, boletas, notas (solo lo que suma)', (() => { const r = registroVentas([V('1'), V('2', { tipo: 'BOLETA', numero: 'B001-1' }), V('3', { estado: 'PENDIENTE' })]); return r.porTipo.find((t) => t.tipo === 'FACTURA')!.documentos === 1 && r.porTipo.find((t) => t.tipo === 'BOLETA')!.total === 118 })())
check('orden cronológico, luego por número', registroVentas([V('2', { fecha: '2026-10-21' }), V('9', { fecha: '2026-10-20', numero: 'F001-9' }), V('1', { fecha: '2026-10-20', numero: 'F001-1' })]).filas.map((f) => f.id).join() === '1,9,2')
check('vacío: todo en cero, sin NaN', (() => { const r = registroVentas([]); return r.filas.length === 0 && r.totales.total === 0 && r.control.every((k) => k.documentos === 0) && !Object.values(r.totales).some((x) => Number.isNaN(x)) })())
check('>>> alertas: factura sin RUC válido y moneda distinta de soles', (() => { const r = registroVentas([V('1', { receptorTipo: 'DNI', receptorNumero: '12345678' }), V('2', { receptorNumero: '123' }), V('3', { moneda: 'USD' }), V('4', { tipo: 'BOLETA', receptorTipo: 'SIN_DOCUMENTO', receptorNumero: null })]); return r.alertas.facturasSinRuc === 2 && r.alertas.otraMoneda === 1 && r.filas.find((f) => f.id === '4')!.alertas.length === 0 })())

console.log('\nB) Conciliación de ventas (propiedad)')
check('>>> 300 casos al azar: Σ totales = Σ filas que suman con su signo, al céntimo; y suma + control = todo', (() => {
  const estados = ['ACEPTADO', 'OBSERVADO', 'PENDIENTE', 'ENVIADO', 'RECHAZADO', 'ANULADO'] as const, tipos = ['FACTURA', 'BOLETA', 'NOTA_CREDITO', 'NOTA_DEBITO'] as const
  for (let i = 0; i < 300; i++) {
    const docs = Array.from({ length: 1 + Math.floor(rnd() * 25) }, (_, k) => {
      const base = Math.round(rnd() * 500000) / 100, igv = Math.round(base * 18) / 100
      return V(`${i}-${k}`, { estado: estados[Math.floor(rnd() * 6)]!, tipo: tipos[Math.floor(rnd() * 4)]!, base, igv, total: Math.round((base + igv) * 100) / 100 })
    })
    const r = registroVentas(docs)
    const esp = docs.filter((d) => d.estado === 'ACEPTADO' || d.estado === 'OBSERVADO').reduce((a, d) => a + (d.tipo === 'NOTA_CREDITO' ? -1 : 1) * Math.round(d.total * 100), 0)
    const ctl = r.control.reduce((a, k) => a + k.documentos, 0)
    if (Math.round(r.totales.total * 100) !== esp || r.totales.documentos + ctl !== docs.length) return false
    if (Math.round((r.totales.base + r.totales.igv) * 100) !== Math.round(r.totales.total * 100) && docs.every((d) => Math.round((d.base + d.igv) * 100) === Math.round(d.total * 100))) return false
  }
  return true
})())

console.log('\nC) Registro de compras')
const K = (id: string, o: Partial<CompraRegistrable> = {}): CompraRegistrable => ({
  id, compra: `C001-${id}`, emision: '2026-10-18', recepcion: '2026-10-20', tipo: 'FACTURA', serie: 'F001', numero: id, referencia: `F001-${id}`, proveedorRuc: '20123456789',
  proveedorNombre: 'Proveedor SAC', base: 100, igv: 18, total: 118, condicion: 'CONTADO', ...o,
})
const k1 = registroCompras([K('1'), K('2', { emision: null, tipo: null, serie: null, numero: null, referencia: 'REF-LIBRE', recepcion: '2026-10-22' })])
check('>>> con documento manda la fecha de EMISIÓN; sin él, la de RECEPCIÓN marcada PROVISIONAL', k1.filas.find((f) => f.id === '1')!.fecha === '2026-10-18' && !k1.filas.find((f) => f.id === '1')!.provisional && k1.filas.find((f) => f.id === '2')!.fecha === '2026-10-22' && k1.filas.find((f) => f.id === '2')!.provisional)
check('>>> el control cuenta las provisionales y su importe; las provisionales SÍ suman al total', k1.control.provisionales === 1 && k1.control.importeProvisional === 118 && k1.totales.total === 236)
check('sin documento estructurado se muestra la referencia libre y el tipo «Sin documento»', k1.filas.find((f) => f.id === '2')!.documento === 'REF-LIBRE' && k1.filas.find((f) => f.id === '2')!.tipoEtiqueta === 'Sin documento' && k1.filas.find((f) => f.id === '1')!.documento === 'F001-1')
check('>>> la nota de crédito de compra RESTA (118 − 59 = 59)', registroCompras([K('1'), K('2', { tipo: 'NOTA_CREDITO', base: 50, igv: 9, total: 59 })]).totales.total === 59)
check('>>> alertas de proveedor: sin proveedor, sin RUC o RUC mal formado', (() => { const r = registroCompras([K('1', { proveedorNombre: null, proveedorRuc: null }), K('2', { proveedorRuc: null }), K('3', { proveedorRuc: '123' }), K('4')]); return r.control.sinProveedor === 1 && r.control.proveedorSinRuc === 2 && r.filas.find((f) => f.id === '4')!.alertas.length === 0 })())
check('por tipo en orden fijo, incluido «sin documento»', registroCompras([K('1', { tipo: 'OTRO' }), K('2'), K('3', { tipo: null, emision: null })]).porTipo.map((t) => t.tipo).join() === 'FACTURA,OTRO,SIN_DOCUMENTO')
check('orden por fecha y documento; vacío sin NaN', registroCompras([K('2', { emision: '2026-10-19' }), K('1')]).filas.map((f) => f.id).join() === '1,2' && registroCompras([]).totales.total === 0)
check('>>> 300 casos al azar: el total es la suma firmada de las filas, al céntimo', (() => {
  for (let i = 0; i < 300; i++) {
    const cs = Array.from({ length: 1 + Math.floor(rnd() * 20) }, (_, k) => { const base = Math.round(rnd() * 300000) / 100; return K(`${i}-${k}`, { base, igv: Math.round(base * 18) / 100, total: Math.round(base * 118) / 100, tipo: rnd() < 0.2 ? 'NOTA_CREDITO' : 'FACTURA', emision: rnd() < 0.3 ? null : '2026-10-10' }) })
    const r = registroCompras(cs)
    if (Math.round(r.totales.total * 100) !== cs.reduce((a, x) => a + (x.tipo === 'NOTA_CREDITO' ? -1 : 1) * Math.round(x.total * 100), 0)) return false
  }
  return true
})())

console.log('\nD) CSV')
const cv = csvRegistroVentas(r2), cvTxt = generarCsv(cv.cabecera, cv.filas)
check('>>> el CSV de ventas lleva los importes CON SIGNO (la nota de crédito en negativo) y la fila TOTAL', cvTxt.includes(';-59.00;') && cvTxt.includes('TOTAL (aceptados y observados)') && cvTxt.includes(';70.80;'))
check('>>> las filas que no suman se marcan «NO» y hay filas de CONTROL por estado', (() => { const t = generarCsv(csvRegistroVentas(r1).cabecera, csvRegistroVentas(r1).filas); return t.includes('CONTROL: PENDIENTE (no suma)') && t.includes('CONTROL: ANULADO (no suma)') })())
check('CSV: BOM, «;» y punto decimal', cvTxt.startsWith('﻿') && cvTxt.includes('118.00'))
const cc = csvRegistroCompras(k1), ccTxt = generarCsv(cc.cabecera, cc.filas)
check('>>> el CSV de compras marca la fecha provisional y trae el control', ccTxt.includes(';SÍ;') && ccTxt.includes('CONTROL: con fecha provisional') && ccTxt.includes('CONTROL: proveedor sin RUC'))
check('>>> un nombre con fórmula no se ejecuta en Excel (protección existente)', (() => { const t = generarCsv(csvRegistroCompras(registroCompras([K('1', { proveedorNombre: '=HYPERLINK("http://x")' })])).cabecera, csvRegistroCompras(registroCompras([K('1', { proveedorNombre: '=HYPERLINK("http://x")' })])).filas); return !/;=HYPERLINK/.test(t) && t.includes("'=HYPERLINK") })())

console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
process.exit(fail === 0 ? 0 : 1)
