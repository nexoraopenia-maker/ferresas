import { randomUUID } from 'node:crypto'
import { MAX_LINEAS_CONTEO, MAX_PRODUCTOS_SELECCION, LARGO_MAXIMO_ZONA, anularPasadaSchema, cancelarConteoSchema, cerrarConteoSchema, crearConteoSchema, iniciarConteoSchema, registrarPasadaSchema } from '../src/features/inventory/conteo-schemas'
import { puedeVerConteos, puedeVerSistema } from '../src/features/inventory/conteo-service'
import { serieDeSucursal } from '../src/features/branches/series'
import { ETIQUETAS, MATRIZ, OPCIONALES, PERMISOS, alcanzable, permisosDeRol } from '../src/lib/permisos'
import { PERMISOS_FUERA_DEL_PIN, permisosDenegadosAlOperador } from '../src/features/seguridad/pin-reglas'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * F6.5a · Lo PURO de la toma de inventario: los esquemas de entrada, los permisos `conteo.registrar` / `conteo.gestionar` (matriz de roles y PIN de operador),
 * quién ve la cantidad del sistema y la serie del número del conteo.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const k = () => randomUUID()

console.log('\nA) crearConteoSchema')
const c = (o: Record<string, unknown>) => crearConteoSchema.safeParse({ warehouseId: 'w1', scope: 'TOTAL', idempotencyKey: k(), ...o })
check('>>> un total solo necesita el almacén y la clave; el modo es CIEGO por defecto', (() => { const r = c({}); return r.success && r.data.mode === 'CIEGO' })())
check('>>> por categoría exige la categoría; por selección, los productos', !c({ scope: 'CATEGORIA' }).success && c({ scope: 'CATEGORIA', categoryId: 'c1' }).success && !c({ scope: 'SELECCION' }).success && c({ scope: 'SELECCION', productIds: ['p1'] }).success)
check('>>> y no admite lo que no corresponde: categoría fuera de «por categoría», productos fuera de «selección»', !c({ scope: 'TOTAL', categoryId: 'c1' }).success && !c({ scope: 'SELECCION', categoryId: 'c1', productIds: ['p1'] }).success && !c({ scope: 'TOTAL', productIds: ['p1'] }).success && !c({ scope: 'CATEGORIA', categoryId: 'c1', productIds: ['p1'] }).success)
check('>>> la selección no puede estar vacía ni repetir productos ni pasar de 2.000', !c({ scope: 'SELECCION', productIds: [] }).success && !c({ scope: 'SELECCION', productIds: ['p1', 'p1'] }).success && !c({ scope: 'SELECCION', productIds: Array.from({ length: MAX_PRODUCTOS_SELECCION + 1 }, (_, i) => `p${i}`) }).success && c({ scope: 'SELECCION', productIds: Array.from({ length: MAX_PRODUCTOS_SELECCION }, (_, i) => `p${i}`) }).success)
check('>>> el modo solo puede ser CIEGO o GUIADO; el alcance, TOTAL, CATEGORIA o SELECCION', c({ mode: 'GUIADO' }).success && !c({ mode: 'ABIERTO' }).success && !c({ scope: 'PARCIAL' }).success)
check('>>> la clave de idempotencia debe ser un UUID y el almacén no puede faltar ni ser larguísimo', !c({ idempotencyKey: 'x' }).success && !c({ warehouseId: '' }).success && !c({ warehouseId: 'w'.repeat(65) }).success && !crearConteoSchema.safeParse({ scope: 'TOTAL', idempotencyKey: k() }).success)
check('>>> la nota admite hasta 280 caracteres', c({ notes: 'n'.repeat(280) }).success && !c({ notes: 'n'.repeat(281) }).success)
check('>>> constantes: 20.000 líneas por conteo, 2.000 productos por selección, zona de 40', MAX_LINEAS_CONTEO === 20_000 && MAX_PRODUCTOS_SELECCION === 2_000 && LARGO_MAXIMO_ZONA === 40)

console.log('\nB) registrarPasadaSchema')
const p = (o: Record<string, unknown>) => registrarPasadaSchema.safeParse({ countId: 'c1', productId: 'p1', quantity: 5, idempotencyKey: k(), ...o })
check('>>> una pasada simple: conteo, producto, cantidad y clave', p({}).success)
check('>>> contar CERO es válido (contar «ninguno» también es contar); lo negativo no', p({ quantity: 0 }).success && !p({ quantity: -1 }).success && !p({ quantity: -0.0001 }).success)
check('>>> hasta 4 decimales; no NaN ni infinito ni absurdos', p({ quantity: 2.5 }).success && p({ quantity: 0.0001 }).success && !p({ quantity: 1.00001 }).success && !p({ quantity: Number.NaN }).success && !p({ quantity: Infinity }).success && !p({ quantity: 1e9 }).success && p({ quantity: 999_999_999 }).success)
check('>>> la cantidad debe ser un número (no texto)', !p({ quantity: '5' }).success && !p({ quantity: undefined }).success && !p({ quantity: null }).success)
check('>>> la presentación y la cantidad ingresada van juntas o ninguna', p({ presentationId: 'pr1', enteredQuantity: 2 }).success && p({ presentationId: 'pr1', enteredQuantity: '2.5' }).success && !p({ presentationId: 'pr1' }).success && !p({ enteredQuantity: 2 }).success && p({ presentationId: null, enteredQuantity: null }).success)
check('>>> la zona se recorta; vacía = sin zona; hasta 40 caracteres', (() => { const a = p({ zone: '  Pasillo 3  ' }); const b = p({ zone: '   ' }); return a.success && a.data.zone === 'Pasillo 3' && b.success && b.data.zone === undefined })() && p({ zone: 'z'.repeat(40) }).success && !p({ zone: 'z'.repeat(41) }).success)
check('>>> variante opcional, clave UUID obligatoria', p({ variantId: 'v1' }).success && p({ variantId: null }).success && !p({ idempotencyKey: 'no' }).success && !p({ idempotencyKey: undefined }).success)

console.log('\nC) Anular, cerrar, cancelar, iniciar')
check('>>> anular una pasada pide el motivo (mínimo 3 letras, máximo 280)', anularPasadaSchema.safeParse({ entryId: 'e1', reason: 'Conté dos veces' }).success && !anularPasadaSchema.safeParse({ entryId: 'e1', reason: 'ab' }).success && !anularPasadaSchema.safeParse({ entryId: 'e1', reason: '  a ' }).success && !anularPasadaSchema.safeParse({ entryId: 'e1', reason: 'x'.repeat(281) }).success && !anularPasadaSchema.safeParse({ reason: 'abc' }).success)
check('>>> cancelar pide motivo; cerrar e iniciar solo el conteo', cancelarConteoSchema.safeParse({ countId: 'c1', reason: 'Se contó mal' }).success && !cancelarConteoSchema.safeParse({ countId: 'c1', reason: '' }).success && !cancelarConteoSchema.safeParse({ countId: 'c1' }).success && cerrarConteoSchema.safeParse({ countId: 'c1' }).success && iniciarConteoSchema.safeParse({ countId: 'c1' }).success && !iniciarConteoSchema.safeParse({}).success && !cerrarConteoSchema.safeParse({ countId: '' }).success)

console.log('\nD) Permisos: matriz de roles y PIN')
check('>>> existen con etiqueta en español y hay 46 permisos', (PERMISOS as readonly string[]).includes('conteo.registrar') && (PERMISOS as readonly string[]).includes('conteo.gestionar') && ETIQUETAS['conteo.registrar'].length > 10 && ETIQUETAS['conteo.gestionar'].length > 10 && PERMISOS.length === 46)
const tiene = (rol: Parameters<typeof permisosDeRol>[0], perm: 'conteo.registrar' | 'conteo.gestionar') => permisosDeRol(rol).has(perm)
check('>>> contar (`conteo.registrar`): dueño, administrador y almacenero; no cajero, vendedor ni contador', tiene('OWNER', 'conteo.registrar') && tiene('ADMIN', 'conteo.registrar') && tiene('ALMACENERO', 'conteo.registrar') && !tiene('CAJERO', 'conteo.registrar') && !tiene('VENDEDOR', 'conteo.registrar') && !tiene('CONTADOR', 'conteo.registrar'))
check('>>> gestionar: dueño y administrador de fábrica; el almacenero NO (lo activa el dueño); los demás, nunca', tiene('OWNER', 'conteo.gestionar') && tiene('ADMIN', 'conteo.gestionar') && !tiene('ALMACENERO', 'conteo.gestionar') && alcanzable('ALMACENERO', 'conteo.gestionar') && !alcanzable('CAJERO', 'conteo.gestionar') && !alcanzable('VENDEDOR', 'conteo.gestionar') && !alcanzable('CONTADOR', 'conteo.gestionar') && (OPCIONALES.ALMACENERO ?? []).includes('conteo.gestionar'))
check('>>> son poderes separados: quien gestiona no cuenta por eso, ni quien cuenta gestiona', MATRIZ.ALMACENERO.includes('conteo.registrar') && !MATRIZ.ALMACENERO.includes('conteo.gestionar') && !(PERMISOS_FUERA_DEL_PIN as readonly string[]).includes('conteo.registrar'))
check('>>> con el PIN de operador SE PUEDE contar pero NO gestionar (ni siquiera el dueño)', (() => { const den = permisosDenegadosAlOperador(new Set(PERMISOS)); return !den.includes('conteo.registrar') && den.includes('conteo.gestionar') })() && (PERMISOS_FUERA_DEL_PIN as readonly string[]).includes('conteo.gestionar'))

console.log('\nE) Quién ve el sistema y quién ve los conteos')
const ctx = (permisosExtra: string[], role: string = 'ALMACENERO') => ({ tenantId: 't', userId: 'u', role, access: 'FULL', permisosExtra } as unknown as TenantContext)
check('>>> en un conteo CIEGO el almacenero que solo cuenta NO ve la cantidad del sistema; con gestionar o con stock.ajustar, sí', !puedeVerSistema(ctx([]), 'CIEGO') && puedeVerSistema(ctx(['conteo.gestionar']), 'CIEGO') && puedeVerSistema(ctx(['stock.ajustar']), 'CIEGO') && puedeVerSistema(ctx([], 'OWNER'), 'CIEGO') && puedeVerSistema(ctx([], 'ADMIN'), 'CIEGO'))
check('>>> en un conteo GUIADO cualquiera que lo vea, ve el sistema', puedeVerSistema(ctx([]), 'GUIADO'))
check('>>> ven los conteos quien cuenta, quien gestiona y quien aprueba (stock.ajustar); no cajero, vendedor ni contador', puedeVerConteos(ctx([])) && puedeVerConteos(ctx([], 'OWNER')) && puedeVerConteos(ctx([], 'ADMIN')) && !puedeVerConteos(ctx([], 'CAJERO')) && !puedeVerConteos(ctx([], 'VENDEDOR')) && !puedeVerConteos(ctx([], 'CONTADOR')) && puedeVerConteos(ctx(['stock.ajustar'], 'CONTADOR')))

console.log('\nF) La serie del número')
check('>>> «CF001» para la sucursal 1 y «CF012» para la 12 (prefijo CF, serie de 3 dígitos)', (() => { const a = serieDeSucursal('INVENTORY_COUNT', 1), b = serieDeSucursal('INVENTORY_COUNT', 12); return a.prefix === 'CF' && a.series === '001' && b.prefix === 'CF' && b.series === '012' })())

console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
process.exit(fail === 0 ? 0 : 1)
