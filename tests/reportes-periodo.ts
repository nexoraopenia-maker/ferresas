import { diaLocal } from '../src/lib/periodos'
import {
  claveDeGrupo, describirPeriodo, diaExiste, diasEntre, etiquetaDeGrupo, granularidadAuto, gruposDelPeriodo, lunesDe, MAX_DIAS_PERIODO, PRESETS_PERIODO,
  resolverPeriodo, sumarDiasDia,
} from '../src/features/reportes/periodo'

/**
 * F5.1 · El periodo de un reporte. PURO: sin base ni red. Lo que más importa: los días son los del NEGOCIO (una venta de las 23:59 en Lima
 * es de ese día aunque en UTC ya sea mañana), dos periodos contiguos nunca se solapan ni dejan huecos, y un rango imposible se rechaza.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const lanza = (f: () => unknown) => { try { f(); return null } catch (e) { return e instanceof RangeError ? e.message : `OTRO: ${String(e)}` } }

const LIMA = 'America/Lima'
// 2026-10-27T03:00Z = lunes 26/10/2026 22:00 en Lima (UTC-5): en UTC ya es martes 27.
const NOCHE = new Date('2026-10-27T03:00:00Z')
const R = (preset: string, ahora = NOCHE, zona = LIMA, extra: { desde?: string; hasta?: string } = {}) => resolverPeriodo({ preset, ...extra }, ahora, zona)

console.log('\nA) Los días son los del negocio')
check('>>> a las 22:00 de Lima del lunes, «hoy» es el LUNES 26 (en UTC ya sería el 27)', R('HOY').desdeDia === '2026-10-26' && R('HOY').hastaDia === '2026-10-26')
check('>>> hoy empieza a medianoche de Lima (05:00Z) y termina a la medianoche siguiente', R('HOY').desde.toISOString() === '2026-10-26T05:00:00.000Z' && R('HOY').hasta.toISOString() === '2026-10-27T05:00:00.000Z')
check('>>> 23:59:59 de Lima cae DENTRO de hoy y 00:00:00 del día siguiente, FUERA', new Date('2026-10-27T04:59:59.999Z') < R('HOY').hasta && new Date('2026-10-27T05:00:00.000Z') >= R('HOY').hasta)
check('ayer = el domingo 25', R('AYER').desdeDia === '2026-10-25' && R('AYER').hastaDia === '2026-10-25')
check('>>> lunes: «esta semana» es solo hoy (las semanas empiezan el lunes)', R('SEMANA').desdeDia === '2026-10-26' && R('SEMANA').dias === 1)
const jueves = new Date('2026-10-29T18:00:00Z')   // jueves 29, 13:00 Lima
check('jueves: esta semana va del lunes 26 al jueves 29 (4 días)', R('SEMANA', jueves).desdeDia === '2026-10-26' && R('SEMANA', jueves).hastaDia === '2026-10-29' && R('SEMANA', jueves).dias === 4)
check('la semana pasada: lunes 19 a domingo 25 (7 días completos)', R('SEMANA_PASADA').desdeDia === '2026-10-19' && R('SEMANA_PASADA').hastaDia === '2026-10-25' && R('SEMANA_PASADA').dias === 7)
check('este mes: del 1 al 26 de octubre', R('MES').desdeDia === '2026-10-01' && R('MES').hastaDia === '2026-10-26' && R('MES').dias === 26)
check('mes pasado: septiembre completo (30 días)', R('MES_PASADO').desdeDia === '2026-09-01' && R('MES_PASADO').hastaDia === '2026-09-30' && R('MES_PASADO').dias === 30)
check('últimos 30 días: 30 días contando hoy', R('ULTIMOS_30').dias === 30 && R('ULTIMOS_30').hastaDia === '2026-10-26' && R('ULTIMOS_30').desdeDia === '2026-09-27')

console.log('\nB) Bordes del calendario')
const enero = new Date('2027-01-15T17:00:00Z')
check('>>> mes pasado desde enero → diciembre del AÑO ANTERIOR', R('MES_PASADO', enero).desdeDia === '2026-12-01' && R('MES_PASADO', enero).hastaDia === '2026-12-31')
const marzo28 = new Date('2028-03-10T17:00:00Z')
check('>>> mes pasado desde marzo de un año BISIESTO → febrero de 29 días', R('MES_PASADO', marzo28).hastaDia === '2028-02-29' && R('MES_PASADO', marzo28).dias === 29)
check('mes pasado desde marzo de un año normal → febrero de 28 días', R('MES_PASADO', new Date('2027-03-10T17:00:00Z')).dias === 28)
check('la semana cruza de mes y de año sin romperse (lunes 28/12/2026 → domingo 3/1/2027)', lunesDe('2027-01-03') === '2026-12-28' && sumarDiasDia('2026-12-28', 6) === '2027-01-03')
check('sumar días cruza meses y años', sumarDiasDia('2026-12-31', 1) === '2027-01-01' && sumarDiasDia('2027-03-01', -1) === '2027-02-28' && sumarDiasDia('2028-03-01', -1) === '2028-02-29')
check('diaExiste: 31 de febrero, mes 13 y 30 de febrero NO; 29/2/2028 SÍ y 29/2/2027 NO', !diaExiste('2026-02-31') && !diaExiste('2026-13-01') && !diaExiste('2028-02-30') && diaExiste('2028-02-29') && !diaExiste('2027-02-29') && !diaExiste('hoy'))
check('diasEntre cuenta ambos extremos', diasEntre('2026-10-01', '2026-10-01') === 1 && diasEntre('2026-10-01', '2026-10-31') === 31 && diasEntre('2028-02-01', '2028-03-01') === 30)

console.log('\nC) Contiguos: ni solapes ni huecos')
check('>>> ayer termina exactamente donde empieza hoy', R('AYER').hasta.getTime() === R('HOY').desde.getTime())
check('>>> la semana pasada termina donde empieza esta semana', R('SEMANA_PASADA').hasta.getTime() === R('SEMANA').desde.getTime())
check('>>> el mes pasado termina donde empieza este mes', R('MES_PASADO').hasta.getTime() === R('MES').desde.getTime())
check('esta semana, este mes y los últimos 30 terminan todos al final de hoy', [R('SEMANA'), R('MES'), R('ULTIMOS_30')].every((p) => p.hasta.getTime() === R('HOY').hasta.getTime()))

console.log('\nD) Rango de fechas')
const rango = (desde?: string, hasta?: string) => lanza(() => R('RANGO', NOCHE, LIMA, { desde, hasta }))
check('un rango válido incluye los dos extremos', R('RANGO', NOCHE, LIMA, { desde: '2026-10-01', hasta: '2026-10-05' }).dias === 5)
check('un solo día (desde = hasta) vale', R('RANGO', NOCHE, LIMA, { desde: '2026-10-05', hasta: '2026-10-05' }).dias === 1)
check('>>> sin las dos fechas → error claro', (rango(undefined, '2026-10-05') ?? '').includes('las dos fechas') && (rango('2026-10-05', undefined) ?? '').includes('las dos fechas') && (rango('', '') ?? '').includes('las dos fechas'))
check('>>> fechas que no existen o mal escritas → error', (rango('2026-02-31', '2026-03-05') ?? '').includes('deben existir') && (rango('05/10/2026', '2026-10-06') ?? '').includes('AAAA-MM-DD'))
check('>>> «hasta» antes de «desde» → error', (rango('2026-10-10', '2026-10-01') ?? '').includes('igual o posterior'))
check(`>>> hasta ${MAX_DIAS_PERIODO} días vale; ${MAX_DIAS_PERIODO + 1} se rechaza`, rango('2026-01-01', '2026-12-31') === null && R('RANGO', NOCHE, LIMA, { desde: '2026-01-01', hasta: '2026-12-31' }).dias === 365 && rango('2025-12-31', '2026-12-31') === null && (rango('2025-12-30', '2026-12-31') ?? '').includes('366'))
check('>>> un año bisiesto completo (366 días) vale; con un día más no', rango('2028-01-01', '2028-12-31') === null && (rango('2027-12-31', '2028-12-31') ?? '').includes('366'))
check('>>> un periodo desconocido o vacío se rechaza (no se adivina)', (lanza(() => R('SIEMPRE')) ?? '').includes('no existe') && (lanza(() => R('')) ?? '').includes('no existe'))
check('el preset no distingue mayúsculas y sin preset es «este mes»', R('hoy').desdeDia === '2026-10-26' && resolverPeriodo({}, NOCHE, LIMA).preset === 'MES')

console.log('\nE) Cambio de hora (zona con horario de verano)')
const NY = 'America/New_York'
const dst = resolverPeriodo({ preset: 'RANGO', desde: '2026-03-08', hasta: '2026-03-08' }, new Date('2026-03-20T16:00:00Z'), NY)
check('>>> el día en que adelantan el reloj dura 23 horas, y aun así es UN día', dst.dias === 1 && (dst.hasta.getTime() - dst.desde.getTime()) === 23 * 3_600_000)
const dst2 = resolverPeriodo({ preset: 'RANGO', desde: '2026-11-01', hasta: '2026-11-01' }, new Date('2026-11-20T16:00:00Z'), NY)
check('>>> el día en que lo atrasan dura 25 horas', (dst2.hasta.getTime() - dst2.desde.getTime()) === 25 * 3_600_000)
const tokio = resolverPeriodo({ preset: 'HOY' }, new Date('2026-10-26T16:00:00Z'), 'Asia/Tokyo')
check('otra zona (Tokio, +9): a las 16:00Z ya es el 27 allá', tokio.desdeDia === '2026-10-27' && tokio.desde.toISOString() === '2026-10-26T15:00:00.000Z')

console.log('\nF) Propiedades sobre 600 instantes al azar y todos los periodos')
let violaciones: string[] = []
const zonas = [LIMA, NY, 'Asia/Tokyo', 'Europe/Madrid']
for (let i = 0; i < 600; i++) {
  const ahora = new Date(Date.UTC(2025, 0, 1) + Math.floor(Math.random() * 3 * 365 * 86_400_000))
  const zona = zonas[i % zonas.length]!
  for (const preset of PRESETS_PERIODO) {
    if (preset === 'RANGO') continue
    const p = resolverPeriodo({ preset }, ahora, zona)
    if (!(p.desde < p.hasta)) violaciones.push(`${preset} ${ahora.toISOString()} desde>=hasta`)
    if (diaLocal(zona, p.desde) !== p.desdeDia) violaciones.push(`${preset} ${zona} desde no es medianoche de ${p.desdeDia}`)
    if (diaLocal(zona, new Date(p.hasta.getTime() - 1)) !== p.hastaDia) violaciones.push(`${preset} ${zona} el último instante no es de ${p.hastaDia}`)
    if (diaLocal(zona, p.hasta) !== sumarDiasDia(p.hastaDia, 1)) violaciones.push(`${preset} ${zona} hasta no es la medianoche siguiente`)
    if (p.dias !== diasEntre(p.desdeDia, p.hastaDia)) violaciones.push(`${preset} dias`)
    if (p.dias > MAX_DIAS_PERIODO) violaciones.push(`${preset} ${p.dias} días de más`)
    // hoy está siempre dentro de los periodos «hasta hoy»
    if (['HOY', 'SEMANA', 'MES', 'ULTIMOS_30'].includes(preset) && !(ahora >= p.desde && ahora < p.hasta)) violaciones.push(`${preset} no contiene «ahora»`)
  }
}
check('>>> 600 instantes × 7 periodos × 4 zonas: empieza a medianoche, termina a la medianoche siguiente, días bien contados, «ahora» dentro', violaciones.length === 0, violaciones.slice(0, 3).join(' | '))

console.log('\nG) Grupos (día, semana, mes)')
const oct = R('MES')
check('por día: un grupo por cada día, sin huecos (26)', gruposDelPeriodo(oct, 'dia').length === 26 && gruposDelPeriodo(oct, 'dia')[0]!.clave === '2026-10-01' && gruposDelPeriodo(oct, 'dia')[25]!.clave === '2026-10-26')
const sem = gruposDelPeriodo(oct, 'semana').map((x) => x.clave)
check('>>> por semana: las semanas se identifican por su LUNES, aunque el periodo empiece a media semana (1/10 es jueves → lunes 28/9)', sem[0] === '2026-09-28' && sem[sem.length - 1] === '2026-10-26' && sem.length === 5, sem.join(','))
check('por mes: un solo grupo para octubre; un rango de 3 meses da 3', gruposDelPeriodo(oct, 'mes').length === 1 && gruposDelPeriodo({ desdeDia: '2026-08-15', hastaDia: '2026-10-05' }, 'mes').map((x) => x.clave).join() === '2026-08,2026-09,2026-10')
check('>>> un rango que cruza el fin de año agrupa bien por mes', gruposDelPeriodo({ desdeDia: '2026-11-20', hastaDia: '2027-02-10' }, 'mes').map((x) => x.clave).join() === '2026-11,2026-12,2027-01,2027-02')
check('>>> una venta de las 23:30 de Lima del 31/10 es de OCTUBRE (en UTC ya sería noviembre)', claveDeGrupo(new Date('2026-11-01T04:30:00Z'), LIMA, 'mes') === '2026-10' && claveDeGrupo(new Date('2026-11-01T05:00:00Z'), LIMA, 'mes') === '2026-11')
check('y del día 31, no del 1', claveDeGrupo(new Date('2026-11-01T04:30:00Z'), LIMA, 'dia') === '2026-10-31')
check('el domingo cae en la semana que empezó el lunes anterior', claveDeGrupo(new Date('2026-11-02T04:00:00Z'), LIMA, 'semana') === '2026-10-26')
check('>>> todo instante del periodo cae en alguno de sus grupos (600 al azar, 3 granularidades)', (() => {
  for (let i = 0; i < 600; i++) {
    const p = R('RANGO', NOCHE, LIMA, { desde: '2026-02-20', hasta: '2026-07-10' })
    const t = new Date(p.desde.getTime() + Math.floor(Math.random() * (p.hasta.getTime() - p.desde.getTime())))
    for (const g of ['dia', 'semana', 'mes'] as const) if (!gruposDelPeriodo(p, g).some((x) => x.clave === claveDeGrupo(t, LIMA, g))) return false
  }
  return true
})())
check('automática: diario hasta 62 días, semanal hasta 183, mensual más allá', granularidadAuto(1) === 'dia' && granularidadAuto(62) === 'dia' && granularidadAuto(63) === 'semana' && granularidadAuto(183) === 'semana' && granularidadAuto(184) === 'mes' && granularidadAuto(366) === 'mes')
check('etiquetas en español: DD/MM/AAAA, «Semana del …», «octubre 2026»', etiquetaDeGrupo('2026-10-05', 'dia') === '05/10/2026' && etiquetaDeGrupo('2026-10-05', 'semana') === 'Semana del 05/10/2026' && etiquetaDeGrupo('2026-10', 'mes') === 'octubre 2026' && etiquetaDeGrupo('2026-09', 'mes') === 'setiembre 2026')
check('describir: un día o un rango', describirPeriodo({ desdeDia: '2026-10-05', hastaDia: '2026-10-05' }) === '05/10/2026' && describirPeriodo({ desdeDia: '2026-10-01', hastaDia: '2026-10-26' }) === '01/10/2026 – 26/10/2026')

console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
process.exit(fail === 0 ? 0 : 1)
