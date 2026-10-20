import { desfaseMs, diaLocal, medianoche, periodos } from '../src/lib/periodos'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}
const LIMA = 'America/Lima'
const iso = (d: Date) => d.toISOString()

console.log('\n1) Lima (UTC-5, sin cambio de hora)')
check('desfase de Lima = -5 h', desfaseMs(LIMA, new Date('2026-10-20T12:00:00Z')) === -5 * 3_600_000)
check('>>> medianoche de Lima = 05:00 UTC', iso(medianoche(LIMA, 2026, 10, 20)) === '2026-10-20T05:00:00.000Z')

// 8 p. m. del martes 20/oct en Lima = 01:00 UTC del miércoles 21.
const noche = new Date('2026-10-21T01:00:00Z')
const p = periodos(noche, LIMA)
check('>>> a las 8 p. m. de Lima «hoy» sigue siendo el 20 (no el 21 del servidor)',
  iso(p.hoy.desde) === '2026-10-20T05:00:00.000Z' && iso(p.hoy.hasta) === '2026-10-21T05:00:00.000Z')
check('diaLocal coincide', diaLocal(LIMA, noche) === '2026-10-20')
check('>>> la semana empieza el LUNES (19/oct)', iso(p.semana.desde) === '2026-10-19T05:00:00.000Z')
check('el mes empieza el día 1', iso(p.mes.desde) === '2026-10-01T05:00:00.000Z')
check('el gráfico trae 7 días, del 14 al 20',
  p.dias7.length === 7 && p.dias7[0] === '2026-10-14' && p.dias7[6] === '2026-10-20', p.dias7.join())
check('todos los rangos acaban mañana a medianoche', [p.hoy, p.semana, p.mes, p.ultimos7].every((r) => iso(r.hasta) === '2026-10-21T05:00:00.000Z'))

console.log('\n2) Un lunes y un domingo')
const lunes = periodos(new Date('2026-10-19T15:00:00Z'), LIMA)
check('el lunes la semana empieza hoy', iso(lunes.semana.desde) === iso(lunes.hoy.desde))
const domingo = periodos(new Date('2026-10-25T15:00:00Z'), LIMA)
check('el domingo la semana empieza 6 días antes (lunes 19)', iso(domingo.semana.desde) === '2026-10-19T05:00:00.000Z')

console.log('\n3) Cambio de mes y de año')
const finAnio = periodos(new Date('2027-01-01T03:00:00Z'), LIMA) // 31/dic 22:00 en Lima
check('>>> 22:00 del 31/dic en Lima sigue siendo diciembre', iso(finAnio.mes.desde) === '2026-12-01T05:00:00.000Z' && finAnio.dias7[6] === '2026-12-31')

console.log('\n4) Una zona con cambio de hora (la lógica no depende de Lima)')
const NY = 'America/New_York'
check('medianoche de Nueva York en verano = 04:00 UTC', iso(medianoche(NY, 2026, 7, 4)) === '2026-07-04T04:00:00.000Z')
check('y en invierno = 05:00 UTC', iso(medianoche(NY, 2026, 1, 4)) === '2026-01-04T05:00:00.000Z')
check('>>> el día del cambio de hora (1/nov/2026) dura 25 h',
  medianoche(NY, 2026, 11, 2).getTime() - medianoche(NY, 2026, 11, 1).getTime() === 25 * 3_600_000)

console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
process.exit(fail === 0 ? 0 : 1)
