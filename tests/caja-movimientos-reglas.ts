import './guard'
import { efectivoEsperado } from '../src/features/branches/cash-service'
import {
  CATEGORIAS_MOVIMIENTO, CATEGORIAS_POR_TIPO, REFERENCIA_OBLIGATORIA_DESDE, TOPE_MOVIMIENTO_SIN_AJUSTE, alcanza, categoriaValida, excedeEfectivo, exigeReferencia,
  mensajeSinPermiso, permisoRequerido, puedeAnular, referenciaSuficiente, type CategoriaMovimiento,
} from '../src/features/branches/cash-movement-reglas'
import { anularMovimientoCajaSchema, registrarMovimientoCajaSchema } from '../src/features/branches/cash-movement-schemas'
import { PERMISOS_FUERA_DEL_PIN, permisosDenegadosAlOperador } from '../src/features/seguridad/pin-reglas'
import { PERMISOS, permisosDeRol } from '../src/lib/permisos'

/**
 * F6.3a · Las reglas de los movimientos manuales de caja, sin base: qué categorías admite cada tipo, quién puede qué (cada permiso basta por sí
 * solo, nunca se exigen dos), el tope, la referencia obligatoria, el aviso de exceso y quién anula. Más el esquema y la fórmula del efectivo esperado.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const KEY = '8b6c2f6e-3a43-4d6e-9a8e-1f4c8a0b2d11'

console.log('\nA) Tipos y categorías')
check('hay 5 categorías y ningún tipo admite una que no le corresponde', CATEGORIAS_MOVIMIENTO.length === 5 && CATEGORIAS_POR_TIPO.INGRESO.every((c) => CATEGORIAS_MOVIMIENTO.includes(c)) && CATEGORIAS_POR_TIPO.EGRESO.every((c) => CATEGORIAS_MOVIMIENTO.includes(c)))
check('>>> un INGRESO puede ser reposición, corrección u otro; NUNCA un gasto menor ni un retiro del dueño', categoriaValida('INGRESO', 'REPOSICION_FONDO') && categoriaValida('INGRESO', 'CORRECCION_ARQUEO') && categoriaValida('INGRESO', 'OTRO') && !categoriaValida('INGRESO', 'GASTO_MENOR') && !categoriaValida('INGRESO', 'RETIRO_DUENO'))
check('>>> un EGRESO puede ser gasto, retiro, corrección u otro; NUNCA una reposición del fondo', categoriaValida('EGRESO', 'GASTO_MENOR') && categoriaValida('EGRESO', 'RETIRO_DUENO') && categoriaValida('EGRESO', 'CORRECCION_ARQUEO') && categoriaValida('EGRESO', 'OTRO') && !categoriaValida('EGRESO', 'REPOSICION_FONDO'))

console.log('\nB) El permiso que hace falta')
check('el tope es S/ 100 por movimiento y la referencia se exige desde S/ 200 (⚠️ operativos)', TOPE_MOVIMIENTO_SIN_AJUSTE === 100 && REFERENCIA_OBLIGATORIA_DESDE === 200)
check('>>> gasto menor y «otro» hasta S/ 100.00 (incluido): `caja.movimientos`', (['GASTO_MENOR', 'OTRO'] as CategoriaMovimiento[]).every((c) => permisoRequerido(c, 1) === 'caja.movimientos' && permisoRequerido(c, 10_000) === 'caja.movimientos'))
check('>>> pasar del tope por UN céntimo (100.01) ya es `caja.ajuste`', (['GASTO_MENOR', 'OTRO'] as CategoriaMovimiento[]).every((c) => permisoRequerido(c, 10_001) === 'caja.ajuste'))
check('>>> retiro del dueño, reposición del fondo y corrección de arqueo son SIEMPRE `caja.ajuste`, aunque sean 1 céntimo', (['RETIRO_DUENO', 'REPOSICION_FONDO', 'CORRECCION_ARQUEO'] as CategoriaMovimiento[]).every((c) => permisoRequerido(c, 1) === 'caja.ajuste'))
const solo = { movimientos: true, ajuste: false }, admin = { movimientos: true, ajuste: true }, soloAjuste = { movimientos: false, ajuste: true }, nada = { movimientos: false, ajuste: false }
check('>>> `caja.movimientos` solo alcanza para lo que se pide con ese permiso', alcanza(solo, 'caja.movimientos') && !alcanza(solo, 'caja.ajuste'))
check('>>> `caja.ajuste` BASTA por sí solo para todo, sin necesitar `caja.movimientos` (un permiso = un poder, nunca los dos a la vez)', alcanza(soloAjuste, 'caja.movimientos') && alcanza(soloAjuste, 'caja.ajuste') && alcanza(admin, 'caja.ajuste'))
check('sin ninguno no alcanza para nada', !alcanza(nada, 'caja.movimientos') && !alcanza(nada, 'caja.ajuste'))
check('>>> los mensajes dicen qué hacer: sin permiso, categoría especial y pasarse del tope', /No tienes permiso/.test(mensajeSinPermiso('GASTO_MENOR', 1, nada)) && /Retiro del dueño solo lo registra/.test(mensajeSinPermiso('RETIRO_DUENO', 1, solo)) && /hasta S\/ 100\.00/.test(mensajeSinPermiso('GASTO_MENOR', 20_000, solo)))

console.log('\nC) Referencia, exceso y anulación')
check('>>> un egreso de S/ 200.00 NO exige referencia; de S/ 200.01 sí; un ingreso nunca', !exigeReferencia('EGRESO', 20_000) && exigeReferencia('EGRESO', 20_001) && !exigeReferencia('INGRESO', 1_000_000))
check('la referencia debe tener al menos 3 caracteres útiles', !referenciaSuficiente(undefined) && !referenciaSuficiente('  ab ') && referenciaSuficiente('F001-12') && referenciaSuficiente(' abc '))
check('>>> un egreso mayor que el esperado excede (aunque sea por 1 céntimo); igual o menor no; un ingreso nunca excede', excedeEfectivo('EGRESO', 5_001, 5_000) && !excedeEfectivo('EGRESO', 5_000, 5_000) && !excedeEfectivo('EGRESO', 100, 5_000) && !excedeEfectivo('INGRESO', 99_999, 0))
check('>>> con esperado cero o negativo, cualquier egreso excede', excedeEfectivo('EGRESO', 1, 0) && excedeEfectivo('EGRESO', 1, -500))
check('>>> anula quien tiene `caja.ajuste` cualquier movimiento', puedeAnular({ tiene: admin, esAutor: false, categoria: 'RETIRO_DUENO', montoCent: 500_000 }) && puedeAnular({ tiene: soloAjuste, esAutor: false, categoria: 'OTRO', montoCent: 100 }))
check('>>> el autor con `caja.movimientos` anula el suyo si era de su alcance (gasto menor ≤ tope)', puedeAnular({ tiene: solo, esAutor: true, categoria: 'GASTO_MENOR', montoCent: 5_000 }))
check('>>> pero NO el de otra persona, ni uno de categoría o monto reservado a `caja.ajuste`, ni sin ningún permiso', !puedeAnular({ tiene: solo, esAutor: false, categoria: 'GASTO_MENOR', montoCent: 5_000 }) && !puedeAnular({ tiene: solo, esAutor: true, categoria: 'RETIRO_DUENO', montoCent: 5_000 }) && !puedeAnular({ tiene: solo, esAutor: true, categoria: 'GASTO_MENOR', montoCent: 10_001 }) && !puedeAnular({ tiene: nada, esAutor: true, categoria: 'GASTO_MENOR', montoCent: 100 }))

console.log('\nD) Esquema')
const ok = { kind: 'EGRESO', category: 'GASTO_MENOR', amount: 25.5, description: 'Bolsas para el mostrador', idempotencyKey: KEY }
check('un movimiento válido se acepta (y `confirmaExceso` nace en falso)', registrarMovimientoCajaSchema.safeParse(ok).success && registrarMovimientoCajaSchema.parse(ok).confirmaExceso === false)
for (const [n, c] of [['monto cero', { amount: 0 }], ['monto negativo', { amount: -5 }], ['tres decimales', { amount: 10.123 }], ['monto enorme', { amount: 1e9 }], ['no finito', { amount: Infinity }],
  ['sin descripción', { description: '' }], ['descripción de 2 letras', { description: 'ab' }], ['descripción gigante', { description: 'x'.repeat(201) }],
  ['categoría inexistente', { category: 'REGALO' }], ['tipo inexistente', { kind: 'PRESTAMO' }], ['clave que no es UUID', { idempotencyKey: 'x' }],
  ['ingreso como gasto menor', { kind: 'INGRESO', category: 'GASTO_MENOR' }], ['egreso como reposición del fondo', { kind: 'EGRESO', category: 'REPOSICION_FONDO' }], ['referencia enorme', { reference: 'r'.repeat(81) }]] as const) {
  check(`>>> ${n}: se rechaza`, !registrarMovimientoCajaSchema.safeParse({ ...ok, ...c }).success)
}
check('anular exige el movimiento y un motivo de al menos 3 letras', anularMovimientoCajaSchema.safeParse({ movementId: 'm1', reason: 'Error de monto' }).success && !anularMovimientoCajaSchema.safeParse({ movementId: 'm1', reason: 'ab' }).success && !anularMovimientoCajaSchema.safeParse({ movementId: '', reason: 'abc' }).success)

console.log('\nE) El efectivo esperado y los permisos de fábrica')
const base = { cashTotal: 500, cashReceiptsTotal: 100, changeTotal: 20, supplierCashPaymentsTotal: 50, refundsCashTotal: 30, manualInTotal: 0, manualOutTotal: 0 }
check('>>> sin movimientos el esperado es el de siempre: 100 + 500 + 100 − 20 − 50 − 30 = 600', efectivoEsperado(100, base) === 600)
check('>>> los ingresos manuales SUMAN y los egresos RESTAN: 600 + 40 − 15.50 = 624.50', efectivoEsperado(100, { ...base, manualInTotal: 40, manualOutTotal: 15.5 }) === 624.5)
check('>>> se redondea al céntimo (sin 0.1 + 0.2)', efectivoEsperado(0, { ...base, cashTotal: 0, cashReceiptsTotal: 0, changeTotal: 0, supplierCashPaymentsTotal: 0, refundsCashTotal: 0, manualInTotal: 0.1, manualOutTotal: -0.2 }) === 0.3)
check('>>> `caja.movimientos` lo tiene el cajero, el administrador y el dueño; NO el vendedor, el almacenero ni el contador', (['CAJERO', 'ADMIN', 'OWNER'] as const).every((r) => permisosDeRol(r).has('caja.movimientos')) && (['VENDEDOR', 'ALMACENERO', 'CONTADOR'] as const).every((r) => !permisosDeRol(r).has('caja.movimientos')))
check('>>> `caja.ajuste` solo el administrador y el dueño (ni el cajero ni el contador)', (['ADMIN', 'OWNER'] as const).every((r) => permisosDeRol(r).has('caja.ajuste')) && (['CAJERO', 'CONTADOR', 'VENDEDOR', 'ALMACENERO'] as const).every((r) => !permisosDeRol(r).has('caja.ajuste')))
check('>>> `caja.ajuste` está FUERA del PIN de operador; `caja.movimientos` (gastos pequeños de mostrador) no', PERMISOS_FUERA_DEL_PIN.includes('caja.ajuste') && !PERMISOS_FUERA_DEL_PIN.includes('caja.movimientos') && permisosDenegadosAlOperador(new Set(PERMISOS)).includes('caja.ajuste'))

console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
process.exit(fail === 0 ? 0 : 1)
