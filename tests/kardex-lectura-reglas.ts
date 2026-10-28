import { codificarCursor, decodificarCursor, resolverRangoKardex } from '../src/features/inventory/kardex-service'
import { DIAS_MAXIMOS_KARDEX, TAMANO_PAGINA_KARDEX, TAMANO_PAGINA_MAXIMO, TOPE_FILAS_CSV_KARDEX, kardexCsvSchema, kardexSchema } from '../src/features/inventory/kardex-schemas'
import { PERMISOS, ETIQUETAS, permisosDeRol } from '../src/lib/permisos'
import { PERMISOS_FUERA_DEL_PIN, permisosDenegadosAlOperador } from '../src/features/seguridad/pin-reglas'

/**
 * F6.4b · Las reglas PURAS del kardex (sin base): el esquema de parámetros, el rango (30 días por defecto, máximo 12 meses, día local del negocio), el
 * cursor y el permiso `kardex.ver` en la matriz de roles y fuera del PIN.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
// Una excepción cuenta como fallo de la prueba (✗), no como un aborto sin veredicto.
const seguro = <T,>(f: () => T, otro: T): T => { try { return f() } catch (e) { console.log(`    (excepción: ${e instanceof Error ? e.message.slice(0, 100) : e})`); return otro } }
const codigoError = (f: () => unknown): string | null => { try { f(); return null } catch (e) { return (e as { code?: string }).code ?? 'OTRO' } }

console.log('\nA) El esquema de parámetros')
const ok = (o: Record<string, unknown>) => kardexSchema.safeParse({ productId: 'p1', ...o })
check('>>> sólo el producto basta; la página por defecto es de 50', (() => { const r = ok({}); return r.success && r.data.limite === TAMANO_PAGINA_KARDEX && r.data.desde === undefined })())
check('>>> constantes: página 50, máximo 200, rango 366 días, CSV 50.000', TAMANO_PAGINA_KARDEX === 50 && TAMANO_PAGINA_MAXIMO === 200 && DIAS_MAXIMOS_KARDEX === 366 && TOPE_FILAS_CSV_KARDEX === 50_000)
check('>>> sin producto, con producto vacío o larguísimo: no vale', !kardexSchema.safeParse({}).success && !ok({ productId: '' }).success && !ok({ productId: 'x'.repeat(65) }).success && !ok({ productId: '   ' }).success)
for (const f of ['2026-13-01', '2026-02-30', '2026-1-1', 'ayer', '28/10/2026', '2026-10-28T10:00', '']) check(`>>> la fecha «${f}» se rechaza`, !ok({ desde: f }).success && !ok({ hasta: f }).success)
check('>>> las fechas reales se aceptan (también el 29 de febrero bisiesto)', ok({ desde: '2026-10-01', hasta: '2026-10-28' }).success && ok({ desde: '2028-02-29' }).success && !ok({ desde: '2027-02-29' }).success)
check('>>> el tamaño de página: 1 a 200, entero', ok({ limite: 1 }).success && ok({ limite: 200 }).success && !ok({ limite: 0 }).success && !ok({ limite: 201 }).success && !ok({ limite: 2.5 }).success && !ok({ limite: -1 }).success)
check('>>> el cursor es texto acotado', ok({ cursor: 'abc' }).success && !ok({ cursor: 'x'.repeat(201) }).success && !ok({ cursor: '' }).success)
check('>>> la exportación no admite cursor ni límite (no pagina): se ignoran', (() => { const r = kardexCsvSchema.safeParse({ productId: 'p', cursor: 'a', limite: 5 }); return r.success && !('cursor' in r.data) && !('limite' in r.data) })())

console.log('\nB) El rango: día local del negocio')
const AHORA = new Date('2026-10-28T20:00:00Z')   // 15:00 en Lima
const lima = (p: Record<string, string>) => seguro(() => resolverRangoKardex('America/Lima', p, AHORA), null)
const r0 = lima({})
check('>>> sin fechas: los últimos 30 días, hoy incluido (2026-09-29 → 2026-10-28)', r0?.desde === '2026-09-29' && r0?.hasta === '2026-10-28')
check('>>> el día empieza a la medianoche de LIMA (05:00 UTC) y `hasta` incluye todo su día', r0?.desdeInst.toISOString() === '2026-09-29T05:00:00.000Z' && r0?.hastaInst.toISOString() === '2026-10-29T05:00:00.000Z')
check('>>> «hoy» es el día local: a las 23:30 de Lima (04:30 UTC del día siguiente) sigue siendo el día de Lima', seguro(() => resolverRangoKardex('America/Lima', {}, new Date('2026-10-29T04:30:00Z')).hasta, '') === '2026-10-28')
check('>>> otra zona (Madrid, +1/+2) cambia las fronteras (a fin de octubre ya es horario de invierno, +1)', seguro(() => resolverRangoKardex('Europe/Madrid', { desde: '2026-10-28', hasta: '2026-10-28' }, AHORA).desdeInst.toISOString(), '') === '2026-10-27T23:00:00.000Z')
check('>>> «hoy» es el de la ZONA del negocio, no el de Lima: a las 04:30 UTC del 29 en Madrid ya es 29, en Lima aún es 28', seguro(() => resolverRangoKardex('Europe/Madrid', {}, new Date('2026-10-29T04:30:00Z')).hasta, '') === '2026-10-29' && seguro(() => resolverRangoKardex('America/Lima', {}, new Date('2026-10-29T04:30:00Z')).hasta, '') === '2026-10-28')
check('>>> sólo `hasta`: 30 días hacia atrás desde ahí', lima({ hasta: '2026-03-31' })?.desde === '2026-03-02')
check('>>> sólo `desde`: llega hasta hoy', lima({ desde: '2026-10-01' })?.hasta === '2026-10-28')
check('>>> un solo día es válido (desde = hasta)', (() => { const r = lima({ desde: '2026-10-10', hasta: '2026-10-10' }); return r?.desdeInst.toISOString() === '2026-10-10T05:00:00.000Z' && r?.hastaInst.toISOString() === '2026-10-11T05:00:00.000Z' })())
check('>>> desde posterior a hasta: INVALID_DOCUMENT', codigoError(() => resolverRangoKardex('America/Lima', { desde: '2026-10-10', hasta: '2026-10-09' }, AHORA)) === 'INVALID_DOCUMENT')
check('>>> 366 días exactos pasan; 367 no (máximo 12 meses)', lima({ desde: '2025-10-28', hasta: '2026-10-28' }) !== null && codigoError(() => resolverRangoKardex('America/Lima', { desde: '2025-10-27', hasta: '2026-10-28' }, AHORA)) === 'INVALID_DOCUMENT')
check('>>> un año bisiesto (2028) cabe en el máximo', lima({ desde: '2028-01-01', hasta: '2028-12-31' }) !== null)
check('>>> el cambio de año no rompe el día siguiente', lima({ desde: '2026-12-31', hasta: '2026-12-31' })?.hastaInst.toISOString() === '2027-01-01T05:00:00.000Z')

console.log('\nC) El cursor')
{
  const t = new Date('2026-10-28T15:00:00.123Z')
  const c = seguro(() => decodificarCursor(codificarCursor({ t, i: 'abc123' })), null)
  check('>>> ida y vuelta: conserva el instante al milisegundo y el id', c?.t.toISOString() === t.toISOString() && c?.i === 'abc123')
  check('>>> el texto es opaco y seguro para una dirección (base64url, sin = + /)', /^[A-Za-z0-9_-]+$/.test(codificarCursor({ t, i: 'x' })))
  for (const [n, v] of [['basura', '%%%'], ['vacío', ''], ['JSON sin forma', Buffer.from('{}').toString('base64url')], ['fecha mala', Buffer.from(JSON.stringify({ t: 'no', i: 'a' })).toString('base64url')],
    ['id vacío', Buffer.from(JSON.stringify({ t: t.toISOString(), i: '' })).toString('base64url')], ['id larguísimo', Buffer.from(JSON.stringify({ t: t.toISOString(), i: 'x'.repeat(65) })).toString('base64url')],
    ['id no texto', Buffer.from(JSON.stringify({ t: t.toISOString(), i: 5 })).toString('base64url')], ['no es objeto', Buffer.from('7').toString('base64url')]] as const) {
    check(`>>> cursor ${n}: INVALID_DOCUMENT (no revienta)`, codigoError(() => decodificarCursor(v)) === 'INVALID_DOCUMENT')
  }
}

console.log('\nD) El permiso `kardex.ver`')
check('>>> existe, con etiqueta, y hay 40 permisos', (PERMISOS as readonly string[]).includes('kardex.ver') && (ETIQUETAS as Record<string, string>)['kardex.ver']!.length > 10 && PERMISOS.length === 40)
const tiene = (rol: Parameters<typeof permisosDeRol>[0]) => permisosDeRol(rol).has('kardex.ver')
check('>>> lo tienen dueño, administrador, contador y almacenero', tiene('OWNER') && tiene('ADMIN') && tiene('CONTADOR') && tiene('ALMACENERO'))
check('>>> NO lo tienen cajero ni vendedor', !tiene('CAJERO') && !tiene('VENDEDOR'))
check('>>> y es independiente de los costos: el almacenero ve kardex pero NO costos; el contador ambos', !permisosDeRol('ALMACENERO').has('productos.ver_costo') && permisosDeRol('CONTADOR').has('productos.ver_costo'))
check('>>> está FUERA del PIN de operador (ni siquiera el dueño lo usa con PIN)', (PERMISOS_FUERA_DEL_PIN as readonly string[]).includes('kardex.ver') && permisosDenegadosAlOperador(new Set(PERMISOS)).includes('kardex.ver'))

console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
process.exit(fail === 0 ? 0 : 1)
