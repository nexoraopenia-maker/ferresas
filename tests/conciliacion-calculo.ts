import {
  armarInforme, cuadre, estaNeutralizado, hallazgoDeCuadre, hallazgoDePuente, hallazgosDeCompras, hallazgosDeEnvio, hallazgosDeNotas, hallazgosDeNumeracion, hallazgosDeVentas,
  hallazgosInformativos, hallazgosVentasCerradas, huecosDeSerie, MENSAJE_SIN_COMPROBANTES, nivelPorAntiguedad, puenteVentas, scopeDeSerie, serieSospechosa, sinValorFiscal,
  totalDesdeAgregados, UMBRAL_ADVERTENCIA_HORAS, UMBRAL_ERROR_HORAS,
  type AgregadoDoc, type DocAbierto, type DocVenta, type Hallazgo, type NotaConc, type SerieConc, type VentaCerrada, type VentaConc,
} from '../src/features/conciliacion/conciliacion-calculo'
import { csvConciliacion } from '../src/features/conciliacion/conciliacion-service'
import { formatearInformeFiscal } from '../src/features/conciliacion/formato'
import { registroCompras, registroVentas, type CompraRegistrable } from '../src/features/registros/registro-calculo'
import { generarCsv } from '../src/lib/csv-export'
import type { ModoFiscal } from '../src/features/invoicing/modo-fiscal'

/**
 * F5.7 · Conciliación fiscal (funciones puras). Lo central: cada venta cae en UNA fila del puente y la diferencia es cero; los umbrales de
 * 24 h / 72 h son exactos; ENSAYO y DEMO nunca pasan de información; nada alarma si no hay nada real que conciliar.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
let semilla = 5
const rnd = () => { semilla = (semilla * 1103515245 + 12345) % 2147483648; return semilla / 2147483648 }
const H = 3_600_000
const AHORA = Date.UTC(2026, 9, 27, 12)
const hace = (horas: number) => AHORA - horas * H
const D = (id: string, o: Partial<DocVenta> = {}): DocVenta => ({ id, tipo: 'BOLETA', numero: `B001-${id}`, estado: 'ACEPTADO', isTrial: false, base: 100, igv: 18, total: 118, receptorTipo: 'SIN_DOCUMENTO', receptorNumero: null, emitidoMs: hace(1), ...o })
const V = (id: string, o: Partial<VentaConc> = {}): VentaConc => ({ id, numero: `V-${id}`, pide: 'BOLETA', total: 118, base: 100, igv: 18, completadaMs: hace(1), doc: D(id), ...o })
const cero = { documentos: 0, total: 0 }
const niveles = (hs: Hallazgo[]) => hs.map((h) => `${h.codigo}:${h.nivel}`).sort().join()

console.log('\nA) Umbrales: 24 h advierte, 72 h es error (⚠️ operativos)')
check('>>> las constantes son 24 y 72', UMBRAL_ADVERTENCIA_HORAS === 24 && UMBRAL_ERROR_HORAS === 72)
check('>>> exactos en el borde: 23.99 h nada, 24 h advertencia, 71.99 h advertencia, 72 h error', nivelPorAntiguedad(23.99) === null && nivelPorAntiguedad(24) === 'ADVERTENCIA' && nivelPorAntiguedad(71.99) === 'ADVERTENCIA' && nivelPorAntiguedad(72) === 'ERROR' && nivelPorAntiguedad(0) === null)
check('>>> venta sin comprobante: 2 h nada; 30 h advertencia; 80 h error', niveles(hallazgosDeVentas([V('1', { doc: null, completadaMs: hace(2) })], AHORA, 'REAL')) === '' && niveles(hallazgosDeVentas([V('1', { doc: null, completadaMs: hace(30) })], AHORA, 'REAL')) === 'VENTA_SIN_COMPROBANTE:ADVERTENCIA' && niveles(hallazgosDeVentas([V('1', { doc: null, completadaMs: hace(80) })], AHORA, 'REAL')) === 'VENTA_SIN_COMPROBANTE:ERROR')
check('>>> una nota de venta (no pide comprobante) NUNCA es hallazgo, por vieja que sea', niveles(hallazgosDeVentas([V('1', { doc: null, pide: 'NOTA_VENTA', completadaMs: hace(500) })], AHORA, 'REAL')) === '')
const abierto = (estado: DocAbierto['estado'], h: number): DocAbierto => ({ id: 'x', numero: 'B001-1', estado, total: 118, emitidoMs: hace(h) })
check('>>> pendiente/enviado: 10 h nada; 30 h advertencia; 80 h error', niveles(hallazgosDeEnvio([abierto('PENDIENTE', 10)], [], AHORA, 'REAL')) === '' && niveles(hallazgosDeEnvio([abierto('ENVIADO', 30)], [], AHORA, 'REAL')) === 'COMPROBANTE_PENDIENTE:ADVERTENCIA' && niveles(hallazgosDeEnvio([abierto('PENDIENTE', 80)], [], AHORA, 'REAL')) === 'COMPROBANTE_PENDIENTE:ERROR')
check('>>> los textos marcan los umbrales como OPERATIVOS, no normativos (⚠️)', hallazgosDeEnvio([abierto('PENDIENTE', 80)], [], AHORA, 'REAL')[0]!.explicacion.includes('⚠️') && hallazgosDeEnvio([abierto('PENDIENTE', 80)], [], AHORA, 'REAL')[0]!.explicacion.includes('no son plazos de SUNAT'))

console.log('\nB) Modos: ENSAYO y DEMO nunca alarman')
const peorCaso = (m: ModoFiscal): Hallazgo[] => [
  ...hallazgosDeVentas([V('1', { doc: null, completadaMs: hace(500) }), V('2', { doc: D('2', { total: 99 }) }), V('3', { doc: D('3', { tipo: 'FACTURA' }) })], AHORA, m),
  ...hallazgosDeEnvio([abierto('PENDIENTE', 500), abierto('RECHAZADO', 500)], [{ numero: 'B001-9', intentos: 5, ultimoError: 'timeout' }], AHORA, m),
  ...hallazgosDeNumeracion([{ tipo: 'BOLETA', serie: 'B001', emitidos: 2, min: 1, max: 5, correlativos: [1, 5], contador: { next: 3, startNumber: 1 } }], m),
]
check('>>> en ENSAYO y en DEMO todo lo anterior baja a INFORMACIÓN (cero errores, cero advertencias)', (['ENSAYO', 'DEMO'] as ModoFiscal[]).every((m) => peorCaso(m).length > 0 && peorCaso(m).every((h) => h.nivel === 'INFO')))
check('>>> en REAL el mismo caso SÍ da errores', peorCaso('REAL').some((h) => h.nivel === 'ERROR') && peorCaso('REAL').some((h) => h.nivel === 'ADVERTENCIA'))
check('sinValorFiscal: solo ENSAYO y DEMO', sinValorFiscal('ENSAYO') && sinValorFiscal('DEMO') && !sinValorFiscal('REAL') && !sinValorFiscal('PAUSADO'))
check('>>> PAUSADO: lo PENDIENTE espera por decisión del dueño (información), pero lo ENVIADO sin respuesta sigue siendo advertencia/error', niveles(hallazgosDeEnvio([abierto('PENDIENTE', 80)], [], AHORA, 'PAUSADO')) === 'COMPROBANTE_PENDIENTE:INFO' && niveles(hallazgosDeEnvio([abierto('ENVIADO', 80)], [], AHORA, 'PAUSADO')) === 'COMPROBANTE_PENDIENTE:ERROR')
check('PAUSADO: lo rechazado y lo agotado siguen igual', niveles(hallazgosDeEnvio([abierto('RECHAZADO', 1)], [{ numero: 'B1', intentos: 3, ultimoError: null }], AHORA, 'PAUSADO')) === 'COMPROBANTE_RECHAZADO:ADVERTENCIA,ENVIO_AGOTADO:ERROR')

console.log('\nC) Puente ventas → comprobantes')
const p1 = puenteVentas([
  V('1'), V('2', { doc: D('2', { estado: 'OBSERVADO' }) }), V('3', { doc: D('3', { estado: 'PENDIENTE' }) }), V('4', { doc: D('4', { estado: 'ENVIADO' }) }), V('5', { doc: D('5', { estado: 'RECHAZADO' }) }),
  V('6', { doc: D('6', { estado: 'ANULADO' }) }), V('7', { doc: D('7', { isTrial: true }) }), V('8', { doc: null }), V('9', { doc: null, pide: 'NOTA_VENTA', total: 50 }),
], { documentos: 2, total: 40 }, { documentos: 1, total: 15 })
check('>>> cada venta cae en UNA fila: válido 2, pendiente+enviado 2, rechazado, anulado, ensayo y sin comprobante 1 cada una; nota de venta aparte', p1.clasificacion.valido.documentos === 2 && p1.clasificacion.pendiente.documentos === 2 && p1.clasificacion.rechazado.documentos === 1 && p1.clasificacion.anulado.documentos === 1 && p1.clasificacion.ensayo.documentos === 1 && p1.clasificacion.sinComprobante.documentos === 1 && p1.notasDeVenta.documentos === 1)
check('>>> la diferencia sin explicar es CERO y los importes cuadran (9 ventas = 1 nota de venta + 8 con comprobante)', p1.diferencia === 0 && p1.ventasCompletadas.documentos === 9 && p1.conComprobante.documentos === 8 && p1.ventasCompletadas.total === 8 * 118 + 50 && p1.conComprobante.total === 8 * 118)
check('anuladas y devueltas van en líneas INFORMATIVAS propias (no entran a la clasificación)', p1.anuladas.total === 40 && p1.devueltas.documentos === 1 && p1.ventasCompletadas.documentos === 9)
check('>>> un comprobante emitido a una venta que "pidió" nota de venta cuenta como con comprobante (manda lo emitido)', puenteVentas([V('1', { pide: 'NOTA_VENTA' })], cero, cero).clasificacion.valido.documentos === 1)
check('sin ventas: todo en cero, sin NaN', (() => { const p = puenteVentas([], cero, cero); return p.diferencia === 0 && p.ventasCompletadas.total === 0 && !JSON.stringify(p).includes('null') && !Number.isNaN(p.diferencia) })())
check('>>> 400 casos al azar: la diferencia es siempre 0 y la suma de la clasificación = con comprobante', (() => {
  const estados = ['ACEPTADO', 'OBSERVADO', 'PENDIENTE', 'ENVIADO', 'RECHAZADO', 'ANULADO'] as const
  for (let i = 0; i < 400; i++) {
    const vs = Array.from({ length: Math.floor(rnd() * 30) }, (_, k) => {
      const total = Math.round(rnd() * 500000) / 100, r = rnd()
      return V(`${i}-${k}`, { total, pide: r < 0.2 ? 'NOTA_VENTA' : rnd() < 0.5 ? 'BOLETA' : 'FACTURA', doc: r < 0.2 || rnd() < 0.15 ? null : D(`${i}-${k}`, { estado: estados[Math.floor(rnd() * 6)]!, isTrial: rnd() < 0.1 }) })
    })
    const p = puenteVentas(vs, cero, cero), k = p.clasificacion
    const sum = k.valido.total + k.pendiente.total + k.rechazado.total + k.anulado.total + k.ensayo.total + k.sinComprobante.total
    if (p.diferencia !== 0 || Math.round(sum * 100) !== Math.round(p.conComprobante.total * 100) || p.ventasCompletadas.documentos !== vs.length) return false
    if (Math.round((p.notasDeVenta.total + p.conComprobante.total) * 100) !== Math.round(p.ventasCompletadas.total * 100)) return false
  }
  return true
})())
check('hallazgoDePuente: sin diferencia no hay hallazgo; con diferencia, ERROR', hallazgoDePuente(p1, 'REAL') === null && hallazgoDePuente({ ...p1, diferencia: 5 }, 'REAL')!.nivel === 'ERROR' && hallazgoDePuente({ ...p1, diferencia: 5 }, 'ENSAYO')!.nivel === 'INFO')

console.log('\nD) Comprobante contra su venta')
check('>>> importes distintos (total, base o IGV) → ERROR; iguales → nada', niveles(hallazgosDeVentas([V('1', { doc: D('1', { total: 117.99 }) })], AHORA, 'REAL')) === 'COMPROBANTE_DISTINTO_A_VENTA:ERROR' && niveles(hallazgosDeVentas([V('1', { doc: D('1', { igv: 17.99 }) })], AHORA, 'REAL')) === 'COMPROBANTE_DISTINTO_A_VENTA:ERROR' && niveles(hallazgosDeVentas([V('1', { doc: D('1', { base: 99 }) })], AHORA, 'REAL')) === 'COMPROBANTE_DISTINTO_A_VENTA:ERROR' && niveles(hallazgosDeVentas([V('1')], AHORA, 'REAL')) === '')
check('el importe del hallazgo es la diferencia (comprobante − venta)', hallazgosDeVentas([V('1', { doc: D('1', { total: 120 }) })], AHORA, 'REAL')[0]!.importe === 2)
check('un comprobante de ENSAYO no se compara (no tiene valor fiscal)', niveles(hallazgosDeVentas([V('1', { doc: D('1', { total: 1, isTrial: true }) })], AHORA, 'REAL')) === '')
check('>>> factura sin RUC de 11 dígitos → advertencia; con RUC válido → nada; la boleta no lo necesita', niveles(hallazgosDeVentas([V('1', { doc: D('1', { tipo: 'FACTURA', receptorTipo: 'DNI', receptorNumero: '12345678' }) })], AHORA, 'REAL')) === 'FACTURA_SIN_RUC:ADVERTENCIA' && niveles(hallazgosDeVentas([V('1', { doc: D('1', { tipo: 'FACTURA', receptorTipo: 'RUC', receptorNumero: '20123456789' }) })], AHORA, 'REAL')) === '' && niveles(hallazgosDeVentas([V('1')], AHORA, 'REAL')) === '')

console.log('\nE) Ventas anuladas o devueltas con comprobante vivo')
const cerr = (doc: Partial<VentaCerrada['doc']>, estado: 'ANULADA' | 'DEVUELTA' = 'ANULADA'): VentaCerrada => ({ id: 'v', numero: 'V-1', estado, doc: { numero: 'B001-1', estado: 'ACEPTADO', total: 118, notas: [], ...doc } })
const nc = (total: number, o: Partial<VentaCerrada['doc']['notas'][number]> = {}) => ({ tipo: 'NOTA_CREDITO' as const, estado: 'ACEPTADO' as const, total, motivoTotal: false, ...o })
check('>>> anulada con comprobante ACEPTADO y sin nota → ERROR; igual si está devuelta', niveles(hallazgosVentasCerradas([cerr({})], 'REAL')) === 'COMPROBANTE_VIVO_EN_VENTA_CERRADA:ERROR' && niveles(hallazgosVentasCerradas([cerr({}, 'DEVUELTA')], 'REAL')) === 'COMPROBANTE_VIVO_EN_VENTA_CERRADA:ERROR')
check('>>> también vivo si está PENDIENTE, ENVIADO u OBSERVADO', ['PENDIENTE', 'ENVIADO', 'OBSERVADO'].every((e) => hallazgosVentasCerradas([cerr({ estado: e as never })], 'REAL').length === 1))
check('>>> neutralizado por una nota de crédito TOTAL → nada', hallazgosVentasCerradas([cerr({ notas: [nc(118, { motivoTotal: true })] })], 'REAL').length === 0)
check('>>> neutralizado por notas que suman el total (60 + 58) → nada; 60 + 50 no alcanza → sigue vivo', hallazgosVentasCerradas([cerr({ notas: [nc(60), nc(58)] })], 'REAL').length === 0 && hallazgosVentasCerradas([cerr({ notas: [nc(60), nc(50)] })], 'REAL').length === 1)
check('>>> una nota RECHAZADA no neutraliza', hallazgosVentasCerradas([cerr({ notas: [nc(118, { estado: 'RECHAZADO', motivoTotal: true })] })], 'REAL').length === 1)
check('una nota de DÉBITO no neutraliza', hallazgosVentasCerradas([cerr({ notas: [{ ...nc(118), tipo: 'NOTA_DEBITO' as const }] })], 'REAL').length === 1)
check('un comprobante rechazado o anulado ya no está vivo', hallazgosVentasCerradas([cerr({ estado: 'RECHAZADO' }), cerr({ estado: 'ANULADO' })], 'REAL').length === 0)
check('estaNeutralizado: sin notas no; con total sí', !estaNeutralizado(cerr({}).doc) && estaNeutralizado(cerr({ notas: [nc(118, { motivoTotal: true })] }).doc))

console.log('\nF) Numeración')
const S = (o: Partial<SerieConc> = {}): SerieConc => ({ tipo: 'BOLETA', serie: 'B001', emitidos: 5, min: 1, max: 5, correlativos: null, contador: { next: 6, startNumber: 1 }, ...o })
check('serie íntegra (1..5, contador en 6): sin hallazgos', hallazgosDeNumeracion([S()], 'REAL').length === 0 && !serieSospechosa(S()))
check('>>> hueco: 1,2,4,5 → faltan el 3; el detalle nombra el número', (() => { const s = S({ emitidos: 4, correlativos: [1, 2, 4, 5] }); const h = hallazgosDeNumeracion([s], 'REAL'); return serieSospechosa(s) && niveles(h) === 'SERIE_CON_HUECOS:ERROR' && h[0]!.items[0]!.detalle.includes('B001-00000003') })())
check('huecosDeSerie: cuenta y limita los ejemplos', (() => { const r = huecosDeSerie(1, 100, [1, 100], 5); return r.faltan === 98 && r.ejemplos.length === 5 && r.ejemplos[0] === 2 })())
check('>>> el arranque cuenta: si el contador arrancó en 1 y el primero emitido es el 4, faltan 1, 2 y 3', (() => { const s = S({ emitidos: 2, min: 4, max: 5, correlativos: [4, 5], contador: { next: 6, startNumber: 1 } }); return serieSospechosa(s) && hallazgosDeNumeracion([s], 'REAL')[0]!.items[0]!.detalle.includes('B001-00000001') })())
check('si la serie arrancó en 500 a propósito, no hay hueco', hallazgosDeNumeracion([S({ emitidos: 2, min: 500, max: 501, correlativos: [500, 501], contador: { next: 502, startNumber: 500 } })], 'REAL').length === 0)
check('>>> contador atrasado (next ≤ max) → ERROR: repetiría un número', niveles(hallazgosDeNumeracion([S({ contador: { next: 5, startNumber: 1 } })], 'REAL')) === 'CONTADOR_ATRASADO:ERROR')
check('contador adelantado (next > max+1) → advertencia', niveles(hallazgosDeNumeracion([S({ contador: { next: 9, startNumber: 1 } })], 'REAL')) === 'CONTADOR_ADELANTADO:ADVERTENCIA')
check('>>> el borde del contador adelantado: próximo = último + 1 es normal; último + 2 ya se saltó un número (6 de B001-5)', hallazgosDeNumeracion([S({ contador: { next: 6, startNumber: 1 } })], 'REAL').length === 0 && niveles(hallazgosDeNumeracion([S({ contador: { next: 7, startNumber: 1 } })], 'REAL')) === 'CONTADOR_ADELANTADO:ADVERTENCIA')
check('sin contador (serie vieja) no se inventa nada; sin emisiones no hay hallazgo', hallazgosDeNumeracion([S({ contador: null }), S({ emitidos: 0, min: 0, max: 0 })], 'REAL').length === 0)
check('scopeDeSerie: factura, boleta, y las notas de crédito por la letra de su serie; la de débito no tiene contador', scopeDeSerie('FACTURA', 'F001') === 'TAX_FACTURA' && scopeDeSerie('BOLETA', 'B001') === 'TAX_BOLETA' && scopeDeSerie('NOTA_CREDITO', 'FC01') === 'TAX_NC_FACTURA' && scopeDeSerie('NOTA_CREDITO', 'BC01') === 'TAX_NC_BOLETA' && scopeDeSerie('NOTA_DEBITO', 'FD01') === null)

console.log('\nG) Notas de crédito')
const N = (o: Partial<NotaConc> = {}): NotaConc => ({ numero: 'BC01-1', tipo: 'NOTA_CREDITO', estado: 'ACEPTADO', total: 100, saleId: 's', original: { numero: 'B001-1', total: 118, saleId: 's', notasCredito: [{ estado: 'ACEPTADO', total: 100 }] }, ...o })
check('una nota dentro del total del original: nada', hallazgosDeNotas([N()], 'REAL').length === 0)
check('>>> notas que suman más que el original (100 + 30 > 118) → ERROR con el exceso (12.00)', (() => { const h = hallazgosDeNotas([N({ original: { numero: 'B001-1', total: 118, saleId: 's', notasCredito: [{ estado: 'ACEPTADO', total: 100 }, { estado: 'ACEPTADO', total: 30 }] } })], 'REAL'); return niveles(h) === 'NOTA_EXCEDE_ORIGINAL:ERROR' && h[0]!.importe === 12 })())
check('>>> el borde: notas que suman EXACTAMENTE el original (100 + 18 = 118) no son exceso; un céntimo más sí', hallazgosDeNotas([N({ original: { numero: 'B001-1', total: 118, saleId: 's', notasCredito: [{ estado: 'ACEPTADO', total: 100 }, { estado: 'ACEPTADO', total: 18 }] } })], 'REAL').length === 0 && hallazgosDeNotas([N({ original: { numero: 'B001-1', total: 118, saleId: 's', notasCredito: [{ estado: 'ACEPTADO', total: 100 }, { estado: 'ACEPTADO', total: 18.01 }] } })], 'REAL')[0]?.importe === 0.01)
check('una nota rechazada no cuenta en la suma', hallazgosDeNotas([N({ original: { numero: 'B001-1', total: 118, saleId: 's', notasCredito: [{ estado: 'ACEPTADO', total: 100 }, { estado: 'RECHAZADO', total: 100 }] } })], 'REAL').length === 0)
check('el mismo original no se reporta dos veces', hallazgosDeNotas([N({ original: { numero: 'B001-1', total: 50, saleId: 's', notasCredito: [{ estado: 'ACEPTADO', total: 100 }] } }), N({ numero: 'BC01-2', original: { numero: 'B001-1', total: 50, saleId: 's', notasCredito: [{ estado: 'ACEPTADO', total: 100 }] } })], 'REAL')[0]!.cantidad === 1)
check('>>> una nota cuya venta no es la de su original → ERROR', niveles(hallazgosDeNotas([N({ saleId: 'otra' })], 'REAL')) === 'NOTA_DE_OTRA_VENTA:ERROR')

console.log('\nH) Registros contra el cálculo independiente')
const ag = (tipo: AgregadoDoc['tipo'], estado: AgregadoDoc['estado'], total: number): AgregadoDoc => ({ tipo, estado, documentos: 1, base: total / 1.18, igv: total - total / 1.18, total })
check('>>> el total independiente suma aceptados y observados y la NC resta (118 + 59 − 29.5 = 147.5); el resto no suma', totalDesdeAgregados([ag('FACTURA', 'ACEPTADO', 118), ag('BOLETA', 'OBSERVADO', 59), ag('NOTA_CREDITO', 'ACEPTADO', 29.5), ag('FACTURA', 'PENDIENTE', 999), ag('BOLETA', 'ANULADO', 999), ag('BOLETA', 'RECHAZADO', 999)]).total === 147.5)
check('>>> coincide con el registro de ventas calculado por la otra ruta (300 casos al azar)', (() => {
  const estados = ['ACEPTADO', 'OBSERVADO', 'PENDIENTE', 'ENVIADO', 'RECHAZADO', 'ANULADO'] as const, tipos = ['FACTURA', 'BOLETA', 'NOTA_CREDITO', 'NOTA_DEBITO'] as const
  for (let i = 0; i < 300; i++) {
    const docs = Array.from({ length: 1 + Math.floor(rnd() * 25) }, (_, k) => { const total = Math.round(rnd() * 500000) / 100; return { id: `${i}-${k}`, fecha: '2026-10-20', tipo: tipos[Math.floor(rnd() * 4)]!, numero: `X-${k}`, relacionado: null, receptorTipo: 'RUC', receptorNumero: '20123456789', receptorNombre: 'C', moneda: 'PEN', base: Math.round(total / 1.18 * 100) / 100, igv: Math.round((total - total / 1.18) * 100) / 100, total, estado: estados[Math.floor(rnd() * 6)]! } })
    const reg = registroVentas(docs)
    const grupos = new Map<string, AgregadoDoc>()
    for (const d of docs) { const k = `${d.tipo}|${d.estado}`; const a = grupos.get(k) ?? { tipo: d.tipo, estado: d.estado, documentos: 0, base: 0, igv: 0, total: 0 }; a.documentos++; a.base += d.base; a.igv += d.igv; a.total += d.total; grupos.set(k, a) }
    if (Math.round(totalDesdeAgregados([...grupos.values()]).total * 100) !== Math.round(reg.totales.total * 100)) return false
  }
  return true
})())
check('cuadre: iguales → sin hallazgo; con diferencia → ERROR con la diferencia (ensayo: información)', hallazgoDeCuadre('REGISTRO_VENTAS_NO_CUADRA', cuadre(100, 100), 'REAL') === null && hallazgoDeCuadre('REGISTRO_VENTAS_NO_CUADRA', cuadre(100, 99.5), 'REAL')!.importe === 0.5 && hallazgoDeCuadre('REGISTRO_COMPRAS_NO_CUADRA', cuadre(100, 90), 'REAL')!.nivel === 'ERROR' && hallazgoDeCuadre('REGISTRO_COMPRAS_NO_CUADRA', cuadre(100, 90), 'ENSAYO')!.nivel === 'INFO')
check('la diferencia del cuadre se calcula en céntimos (0.1 + 0.2 vs 0.3 → 0)', cuadre(0.1 + 0.2, 0.3).diferencia === 0)

console.log('\nI) Compras e informativos')
const K = (id: string, o: Partial<CompraRegistrable> = {}): CompraRegistrable => ({ id, compra: `C-${id}`, emision: '2026-10-18', recepcion: '2026-10-20', tipo: 'FACTURA', serie: 'F001', numero: id, referencia: null, proveedorRuc: '20123456789', proveedorNombre: 'Prov', base: 100, igv: 18, total: 118, condicion: 'CONTADO', ...o })
check('compras sin problemas: nada', hallazgosDeCompras(registroCompras([K('1')]), 'REAL').length === 0)
check('>>> provisionales, proveedor sin RUC y sin proveedor → advertencias, cada una con su enlace a la compra', (() => { const h = hallazgosDeCompras(registroCompras([K('1', { emision: null, tipo: null, serie: null, numero: null }), K('2', { proveedorRuc: null }), K('3', { proveedorNombre: null, proveedorRuc: null })]), 'REAL'); return niveles(h) === 'COMPRAS_PROVEEDOR_SIN_RUC:ADVERTENCIA,COMPRAS_PROVISIONALES:ADVERTENCIA,COMPRAS_SIN_PROVEEDOR:ADVERTENCIA' && h.every((x) => x.items.every((it) => it.enlace?.startsWith('/compras/'))) })())
check('>>> informativos: ensayo avisa que no se concilió como real; devueltas y anuladas se explican', (() => { const h = hallazgosInformativos({ ...p1 }, 'ENSAYO', p1.clasificacion.valido.total); return niveles(h) === 'MODO_SIN_VALOR_FISCAL:INFO,VENTAS_ANULADAS_O_DEVUELTAS:INFO' })())
check('>>> diferencia de fechas: se EXPLICA como información cuando el bruto por emisión difiere del de la venta; si coinciden, nada', niveles(hallazgosInformativos(p1, 'REAL', p1.clasificacion.valido.total + 118)).includes('DIFERENCIA_DE_FECHAS:INFO') && !niveles(hallazgosInformativos(p1, 'REAL', p1.clasificacion.valido.total)).includes('DIFERENCIA_DE_FECHAS'))

check('>>> comprobantes válidos de ventas ya devueltas (F6.1): se explican aparte (INFO) y NO se confunden con una diferencia de fechas', (() => { const h = hallazgosInformativos(p1, 'REAL', p1.clasificacion.valido.total + 118, { documentos: 1, total: 118 }); return niveles(h).includes('COMPROBANTES_DE_VENTAS_DEVUELTAS:INFO') && !niveles(h).includes('DIFERENCIA_DE_FECHAS') && h.find((x) => x.codigo === 'COMPROBANTES_DE_VENTAS_DEVUELTAS')!.cantidad === 1 })())
check('>>> y si ADEMÁS hay una diferencia de fechas real (50.00 más), esa se sigue explicando por separado', (() => { const h = hallazgosInformativos(p1, 'REAL', p1.clasificacion.valido.total + 118 + 50, { documentos: 1, total: 118 }); return h.find((x) => x.codigo === 'DIFERENCIA_DE_FECHAS')?.importe === 50 })())
check('sin ventas devueltas el aviso no aparece (comportamiento de siempre)', !niveles(hallazgosInformativos(p1, 'REAL', p1.clasificacion.valido.total)).includes('COMPROBANTES_DE_VENTAS_DEVUELTAS'))

console.log('\nJ) Estado general')
const base = { modo: 'REAL' as ModoFiscal, puente: puenteVentas([], cero, cero), cuadreVentas: cuadre(0, 0), cuadreCompras: cuadre(0, 0), comprobantesReales: 0, registroVentas: registroVentas([]), comprasEnRegistro: 0 }
const hall = (nivel: Hallazgo['nivel']): Hallazgo => ({ codigo: 'FACTURA_SIN_RUC', nivel, titulo: 't', explicacion: 'e', cantidad: 1, importe: 1, items: [] })
check('>>> nada real que conciliar → «Sin comprobantes reales que conciliar en este periodo.» sin alertas', (() => { const r = armarInforme({ ...base, hallazgos: [] }); return r.estado === 'SIN_COMPROBANTES' && r.mensaje === MENSAJE_SIN_COMPROBANTES && r.resumen.errores === 0 && r.resumen.advertencias === 0 })())
check('>>> y lo sigue siendo con solo hallazgos informativos (modo ensayo, ventas sin comprobante en ensayo…)', armarInforme({ ...base, modo: 'ENSAYO', hallazgos: [hall('INFO')] }).estado === 'SIN_COMPROBANTES')
check('hay comprobantes reales y todo cuadra → LIMPIO', armarInforme({ ...base, comprobantesReales: 3, hallazgos: [] }).estado === 'LIMPIO')
check('solo advertencias → ADVERTENCIAS; con un error → ERRORES (aunque haya advertencias)', armarInforme({ ...base, comprobantesReales: 3, hallazgos: [hall('ADVERTENCIA')] }).estado === 'ADVERTENCIAS' && armarInforme({ ...base, comprobantesReales: 3, hallazgos: [hall('ADVERTENCIA'), hall('ERROR')] }).estado === 'ERRORES')
check('>>> un puente que no cuadra es ERRORES por sí solo', armarInforme({ ...base, comprobantesReales: 3, puente: { ...base.puente, diferencia: 1 }, hallazgos: [] }).estado === 'ERRORES')
check('orden: errores primero, luego advertencias, luego información; dentro, por importe', armarInforme({ ...base, hallazgos: [hall('INFO'), { ...hall('ERROR'), importe: 5 }, hall('ADVERTENCIA'), { ...hall('ERROR'), importe: 50 }] }).hallazgos.map((h) => `${h.nivel}:${h.importe}`).join() === 'ERROR:50,ERROR:5,ADVERTENCIA:1,INFO:1')
check('con compras en el registro, un negocio sin comprobantes NO es «sin comprobantes»: es LIMPIO', armarInforme({ ...base, comprasEnRegistro: 2, hallazgos: [] }).estado === 'LIMPIO')

console.log('\nK) CSV y consola')
const inf = armarInforme({ ...base, comprobantesReales: 3, hallazgos: [{ ...hall('ERROR'), titulo: 'Un error', items: [{ referencia: '=HYPERLINK("x")', detalle: 'detalle', importe: 12.5, enlace: null }] }] })
const tabla = csvConciliacion(inf), txt = generarCsv(tabla.cabecera, tabla.filas)
check('>>> el CSV trae el nivel, el código, la referencia y el importe, el puente y el cuadre', txt.includes('Error;FACTURA_SIN_RUC;Un error') && txt.includes(';12.50') && txt.includes('PUENTE') && txt.includes('Diferencia sin explicar (debe ser 0)') && txt.includes('CUADRE'))
check('>>> con protección contra fórmulas: una referencia que empieza con «=» no se ejecuta en Excel', !/;=HYPERLINK/.test(txt) && txt.includes("'=HYPERLINK"))
check('CSV: BOM, «;» y punto decimal', txt.startsWith('﻿'))
check('un hallazgo sin items igualmente sale en el CSV, con su explicación', generarCsv(csvConciliacion(armarInforme({ ...base, hallazgos: [{ ...hall('INFO'), items: [], explicacion: 'Solo informativo' }] })).cabecera, csvConciliacion(armarInforme({ ...base, hallazgos: [{ ...hall('INFO'), items: [], explicacion: 'Solo informativo' }] })).filas).includes('Solo informativo'))
const consola = formatearInformeFiscal('acme', '20/10/2026 – 26/10/2026', inf, false)
check('>>> la consola muestra el negocio, el modo, el puente (con su diferencia sin explicar), el cuadre y cada hallazgo con su nivel', consola.includes('diferencia sin explicar S/ 0.00') && consola.includes('acme') && consola.includes('modo Real') && consola.includes('Puente:') && consola.includes('Cuadre:') && consola.includes('[ERROR] Un error'))
check('sin --detalle solo tres items y avisa; con --detalle, todos', (() => { const h = { ...hall('ERROR'), cantidad: 6, items: Array.from({ length: 6 }, (_, i) => ({ referencia: `R${i}`, detalle: 'd', importe: null, enlace: null })) }; const a = formatearInformeFiscal('x', 't', armarInforme({ ...base, hallazgos: [h] }), false), b = formatearInformeFiscal('x', 't', armarInforme({ ...base, hallazgos: [h] }), true); return a.includes('… y 3 más') && !a.includes('R5') && b.includes('R5') && !b.includes('… y') })())

console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
process.exit(fail === 0 ? 0 : 1)
