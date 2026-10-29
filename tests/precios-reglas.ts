import { readFileSync } from 'node:fs'
import { MAX_LISTAS_POR_NEGOCIO, MAX_TRAMOS_POR_ENTRADA, TOLERANCIA_PISO, brutoDeLinea, conservaPrecioPropioDePresentacion, pisoDeCosto, resolverPrecio, tramoParaCantidad, validarTramos, type DatosDePrecio } from '../src/features/pos/precios-reglas'
import { cambioPrecioSchema, crearListaSchema, guardarPreciosSchema, MAX_CAMBIOS_PRECIOS } from '../src/features/precios/schemas'
import { ETIQUETAS, PERMISOS, permisosDeRol, OPCIONALES } from '../src/lib/permisos'
import { PERMISOS_FUERA_DEL_PIN } from '../src/features/seguridad/pin-reglas'

/**
 * F6.7a · Las reglas PURAS de precio, sin base de datos: qué precio manda según la lista y la cantidad (con el ejemplo del diseño), los bordes de los tramos, la herencia de la Base, las
 * presentaciones, la validación de tramos, el piso de margen (con el IVA extraído, el costo 0 y el redondeo), los esquemas y los permisos nuevos.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }

// El ejemplo del diseño: «Cinta aislante». Base 3.50 con tramo «desde 100 → 3.20»; Mayorista 3.10 con tramo «desde 12 → 2.90»; Constructor sin entrada.
const BASE_T = [{ minQuantity: 100, unitPrice: 3.2 }]
const cinta = (entrada: DatosDePrecio['entrada']): DatosDePrecio => ({ salePrice: 3.5, baseTiers: BASE_T, entrada })
const MAYORISTA = { price: 3.1, tiers: [{ minQuantity: 12, unitPrice: 2.9 }] }

console.log('\nA) El ejemplo del diseño')
const r = (d: DatosDePrecio, q: number) => resolverPrecio(d, q)
check('>>> Base, 5 u → 3.50 (BASE)', r(cinta(null), 5).precio === 3.5 && r(cinta(null), 5).fuente === 'BASE' && r(cinta(null), 5).tramo === null)
check('>>> Base, 120 u → 3.20 (VOLUMEN, tramo 100)', r(cinta(null), 120).precio === 3.2 && r(cinta(null), 120).fuente === 'VOLUMEN' && r(cinta(null), 120).tramo === 100)
check('>>> Mayorista, 5 u → 3.10 (LISTA)', r(cinta(MAYORISTA), 5).precio === 3.1 && r(cinta(MAYORISTA), 5).fuente === 'LISTA' && r(cinta(MAYORISTA), 5).deLista)
check('>>> Mayorista, 12 u → 2.90 (VOLUMEN)', r(cinta(MAYORISTA), 12).precio === 2.9 && r(cinta(MAYORISTA), 12).fuente === 'VOLUMEN' && r(cinta(MAYORISTA), 12).tramo === 12)
check('>>> >>> Mayorista, 120 u → 2.90: los tramos de la Base NO se mezclan con los de una lista que tiene entrada', r(cinta(MAYORISTA), 120).precio === 2.9)
check('>>> >>> una lista sin entrada para el producto hereda la Base COMPLETA, tramo incluido (120 u → 3.20)', r(cinta(null), 120).precio === 3.2 && !r(cinta(null), 120).deLista)

console.log('\nB) Bordes de los tramos')
check('>>> justo en la cantidad mínima aplica (12 → tramo; 11.9999 → plano)', r(cinta(MAYORISTA), 12).fuente === 'VOLUMEN' && r(cinta(MAYORISTA), 11.9999).fuente === 'LISTA' && r(cinta(MAYORISTA), 11.9999).precio === 3.1)
check('>>> sin errores de coma flotante: 11.1 + 0.9 = 12 aplica el tramo de 12', r(cinta(MAYORISTA), 11.1 + 0.9).fuente === 'VOLUMEN')
const varios = [{ minQuantity: 10, unitPrice: 9 }, { minQuantity: 50, unitPrice: 8 }, { minQuantity: 200, unitPrice: 7 }]
check('>>> con varios tramos manda el de MAYOR cantidad que no se pase (10, 49 → 9; 50, 199 → 8; 500 → 7)', [10, 49, 50, 199, 500].map((q) => tramoParaCantidad(varios, q)?.unitPrice).join() === '9,9,8,8,7')
check('>>> el orden en que llegan los tramos no importa', tramoParaCantidad([...varios].reverse(), 60)?.unitPrice === 8 && tramoParaCantidad([varios[1]!, varios[2]!, varios[0]!], 60)?.unitPrice === 8)
check('>>> menos que el primer tramo: ninguno', tramoParaCantidad(varios, 9.9999) === null && tramoParaCantidad([], 1000) === null)
check('>>> cantidad 0 o negativa no aplica tramos', tramoParaCantidad(varios, 0) === null && tramoParaCantidad(varios, -5) === null)

console.log('\nC) Una entrada con solo tramos, o con solo precio')
const soloTramos = cinta({ price: null, tiers: [{ minQuantity: 10, unitPrice: 3 }] })
check('>>> solo tramos: debajo del tramo, el plano es el precio base (3.50) y la fuente es BASE', r(soloTramos, 5).precio === 3.5 && r(soloTramos, 5).fuente === 'BASE' && r(soloTramos, 5).deLista)
check('>>> solo tramos: desde el tramo, el del tramo (3.00)', r(soloTramos, 10).precio === 3 && r(soloTramos, 10).fuente === 'VOLUMEN')
check('>>> solo precio plano (sin tramos): nunca usa los de la Base', r(cinta({ price: 3.1, tiers: [] }), 500).precio === 3.1)
check('>>> un precio plano en 0 es un precio (no «vacío»)', r(cinta({ price: 0, tiers: [] }), 5).precio === 0 && r(cinta({ price: 0, tiers: [] }), 5).fuente === 'LISTA')
check('>>> el precio se mantiene en 4 decimales', r({ salePrice: 2.91666667, baseTiers: [], entrada: null }, 1).precio === 2.9167)

console.log('\nD) Presentaciones y el importe de la línea')
check('>>> con precio propio de caja manda ese precio solo si manda la Base sin tramo', conservaPrecioPropioDePresentacion(r(cinta(null), 5)) === true)
check('>>> con un tramo, o con precio de lista, el precio propio se ignora', conservaPrecioPropioDePresentacion(r(cinta(null), 120)) === false && conservaPrecioPropioDePresentacion(r(cinta(MAYORISTA), 5)) === false)
check('>>> una caja de 50 se evalúa como 50 unidades base: 1 caja de 50 con tramo «desde 12» → 2.90 por unidad', r(cinta(MAYORISTA), 1 * 50).precio === 2.9)
check('>>> bruto = precio × cantidad base a céntimos (2.9 × 50 = 145.00; 2.9167 × 3 = 8.75)', brutoDeLinea(2.9, 50) === 145 && brutoDeLinea(2.9167, 3) === 8.75)

console.log('\nE) Validar los tramos de una entrada')
const v = (t: { minQuantity: number; unitPrice: number }[], plano: number | null = 10) => validarTramos(t, plano)
check('>>> tramos bien formados: sin error', v([{ minQuantity: 10, unitPrice: 9 }, { minQuantity: 50, unitPrice: 8 }]) === null && v([]) === null)
check('>>> el orden de entrada no importa para validar', v([{ minQuantity: 50, unitPrice: 8 }, { minQuantity: 10, unitPrice: 9 }]) === null)
check('>>> >>> más cantidad no puede costar más por unidad', /no puede costar más/.test(v([{ minQuantity: 10, unitPrice: 8 }, { minQuantity: 50, unitPrice: 9 }]) ?? ''))
check('>>> igual precio en dos tramos sí se admite', v([{ minQuantity: 10, unitPrice: 8 }, { minQuantity: 50, unitPrice: 8 }]) === null)
check('>>> ningún tramo cuesta más que el plano', /más que el precio plano/.test(v([{ minQuantity: 10, unitPrice: 11 }]) ?? '') && v([{ minQuantity: 10, unitPrice: 10 }]) === null)
check('>>> sin plano conocido no se compara con él', v([{ minQuantity: 10, unitPrice: 9999 }], null) === null)
check('>>> dos tramos desde la misma cantidad se rechazan', /misma cantidad/.test(v([{ minQuantity: 10, unitPrice: 9 }, { minQuantity: 10, unitPrice: 8 }]) ?? ''))
check('>>> cantidad mínima 0, negativa o NaN se rechaza', [0, -1, Number.NaN].every((q) => v([{ minQuantity: q, unitPrice: 5 }]) !== null))
check('>>> precio negativo o NaN se rechaza', [-1, Number.NaN].every((p) => v([{ minQuantity: 5, unitPrice: p }]) !== null))
check('>>> más de 4 decimales se rechaza (cantidad y precio)', v([{ minQuantity: 5.00001, unitPrice: 5 }]) !== null && v([{ minQuantity: 5, unitPrice: 5.00001 }]) !== null && v([{ minQuantity: 5.0001, unitPrice: 5.0001 }]) === null)
check(`>>> hasta ${MAX_TRAMOS_POR_ENTRADA} tramos por entrada`, v(Array.from({ length: MAX_TRAMOS_POR_ENTRADA }, (_, i) => ({ minQuantity: i + 1, unitPrice: 9 - i * 0.1 }))) === null && v(Array.from({ length: MAX_TRAMOS_POR_ENTRADA + 1 }, (_, i) => ({ minQuantity: i + 1, unitPrice: 5 }))) !== null)

console.log('\nF) El piso de margen')
const piso = (neto: number, cantidad: number, costo: number, tasa = 0.18) => pisoDeCosto({ netoLinea: neto, tasaIgv: tasa, cantidadBase: cantidad, costoUnitario: costo })
check('>>> por encima del costo cumple (118 con IGV = 100 sin IGV; costo 90 × 1)', piso(118, 1, 90).cumple && !piso(118, 1, 90).exento)
check('>>> >>> EXACTAMENTE al costo cumple (118 con IGV, costo 100)', piso(118, 1, 100).cumple)
check('>>> un poco bajo el costo NO cumple (117 con IGV = 99.15 sin IGV; costo 100)', !piso(117, 1, 100).cumple)
check('>>> el IGV se extrae: 100 con IGV NO cubre un costo de 100 (son 84.75 sin IGV)', !piso(100, 1, 100).cumple)
check('>>> multiplica por la cantidad base: 10 u a 1.18 c/u (11.80) con costo 1.00 cumple; con costo 1.20 no', piso(11.8, 10, 1).cumple && !piso(11.8, 10, 1.2).cumple)
check('>>> el descuento manual ya viene dentro del neto: 118 − 20 = 98 con IGV son 83.05 sin IGV y no cubren un costo de 90', !piso(98, 1, 90).cumple)
check('>>> un precio redondeado a céntimos exactamente al costo no falla por el redondeo (costo 0.05, neto 0.06 con IGV)', piso(0.06, 1, 0.05).cumple)
check(`>>> la tolerancia es de medio céntimo (${TOLERANCIA_PISO}), no más: 1 céntimo bajo el costo en una línea de costo 1.00 NO cumple`, !piso(1.17, 1, 1).cumple && piso(1.18, 1, 1).cumple)
check('>>> >>> costo 0 o desconocido: EXENTO (no hay contra qué comparar)', piso(0.01, 1, 0).exento && piso(0.01, 1, 0).cumple && piso(5, 1, -3).exento && piso(5, 1, Number.NaN).exento)
check('>>> producto exonerado (tasa 0): el neto es el sin IGV', piso(10, 1, 10, 0).cumple && !piso(9.9, 1, 10, 0).cumple)
check('>>> vender gratis un producto con costo no cumple', !piso(0, 3, 2.5).cumple)
check('>>> el resultado no trae el costo ni el margen (solo si cumple)', JSON.stringify(Object.keys(piso(118, 1, 90)).sort()) === JSON.stringify(['cumple', 'exento']))

console.log('\nG) Esquemas')
const ok = (c: unknown) => cambioPrecioSchema.safeParse(c).success
check('>>> un cambio necesita precio, tramos o quitar la entrada', !ok({ productId: 'p' }) && ok({ productId: 'p', price: 5 }) && ok({ productId: 'p', tiers: [] }) && ok({ productId: 'p', eliminar: true }))
check('>>> quitar la entrada no admite otros cambios', !ok({ productId: 'p', eliminar: true, price: 5 }) && !ok({ productId: 'p', eliminar: true, tiers: [] }))
check('>>> null en el precio = quitar el plano (válido); negativo o con 5 decimales no', ok({ productId: 'p', price: null }) && !ok({ productId: 'p', price: -1 }) && !ok({ productId: 'p', price: 1.00001 }))
check('>>> un tramo con cantidad 0 o precio negativo no pasa el esquema', !ok({ productId: 'p', tiers: [{ minQuantity: 0, unitPrice: 1 }] }) && !ok({ productId: 'p', tiers: [{ minQuantity: 1, unitPrice: -1 }] }))
check('>>> más tramos que el tope no pasa', !ok({ productId: 'p', tiers: Array.from({ length: MAX_TRAMOS_POR_ENTRADA + 1 }, (_, i) => ({ minQuantity: i + 1, unitPrice: 1 })) }))
check('>>> un lote vacío, o de más del tope, no pasa; la lista puede ser null (Base)', !guardarPreciosSchema.safeParse({ priceListId: null, cambios: [] }).success && guardarPreciosSchema.safeParse({ priceListId: null, cambios: [{ productId: 'p', tiers: [] }] }).success && !guardarPreciosSchema.safeParse({ priceListId: 'l', cambios: Array.from({ length: MAX_CAMBIOS_PRECIOS + 1 }, (_, i) => ({ productId: `p${i}`, price: 1 })) }).success)
check('>>> nombre de lista: 2 a 40 letras; código sin espacios ni símbolos', crearListaSchema.safeParse({ name: 'Mayorista' }).success && !crearListaSchema.safeParse({ name: 'A' }).success && !crearListaSchema.safeParse({ name: 'x'.repeat(41) }).success && crearListaSchema.safeParse({ name: 'Mayorista', code: 'MAY-01' }).success && !crearListaSchema.safeParse({ name: 'Mayorista', code: 'con espacio' }).success)
check('>>> los topes del diseño: 20 listas por negocio y 10 tramos por entrada', MAX_LISTAS_POR_NEGOCIO === 20 && MAX_TRAMOS_POR_ENTRADA === 10)

console.log('\nH) Permisos nuevos: un permiso = un poder')
const rol = (x: Parameters<typeof permisosDeRol>[0]) => permisosDeRol(x)
check('>>> existen, con etiqueta en español', (PERMISOS as readonly string[]).includes('precios.gestionar') && (PERMISOS as readonly string[]).includes('ventas.bajo_costo') && ETIQUETAS['precios.gestionar'].length > 10 && ETIQUETAS['ventas.bajo_costo'].length > 10)
check('>>> de fábrica solo dueño y administrador', rol('OWNER').has('precios.gestionar') && rol('ADMIN').has('precios.gestionar') && rol('OWNER').has('ventas.bajo_costo') && rol('ADMIN').has('ventas.bajo_costo'))
check('>>> ni cajero, ni vendedor, ni almacenero, ni contador', (['CAJERO', 'VENDEDOR', 'ALMACENERO', 'CONTADOR'] as const).every((x) => !rol(x).has('precios.gestionar') && !rol(x).has('ventas.bajo_costo')))
check('>>> sin opcionales: el dueño no puede delegarlos todavía a otro rol', !Object.values(OPCIONALES).some((ps) => (ps ?? []).some((p) => p === 'precios.gestionar' || p === 'ventas.bajo_costo')))
check('>>> los dos quedan FUERA del PIN', PERMISOS_FUERA_DEL_PIN.includes('precios.gestionar') && PERMISOS_FUERA_DEL_PIN.includes('ventas.bajo_costo'))
check('>>> ver las listas al vender NO tiene permiso propio (quien vende las ve)', !(PERMISOS as readonly string[]).some((p) => /precios\.(ver|elegir|listar)/.test(p)))

console.log('\nI) El motor es puro')
const fuente = readFileSync('src/features/pos/precios-reglas.ts', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
check('>>> no importa Prisma, React ni nada del servidor (lo usa también el carrito del navegador)', !/from '@\/(lib\/prisma|generated|lib\/tenant)|from 'react|from 'next|node:/.test(fuente))

console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
process.exit(fail === 0 ? 0 : 1)
