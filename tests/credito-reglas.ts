import { readFileSync } from 'node:fs'
import { resolverPagos, MENSAJE_FIADO_CLIENTE, MENSAJE_FIADO_EXACTO, MENSAJE_FIADO_FACTURA, MENSAJE_FIADO_UNA_LINEA, type MetodoPago } from '../src/features/pos/pagos'
import { registerSaleSchema } from '../src/features/pos/schemas'
import { ETIQUETAS, MATRIZ, OPCIONALES, PERMISOS, alcanzable, esOpcional, permisosDeRol, permisosEfectivos, type Permiso } from '../src/lib/permisos'
import { PERMISOS_FUERA_DEL_PIN, permisosDenegadosAlOperador } from '../src/features/seguridad/pin-reglas'
import { BusinessError } from '../src/lib/errors'
import type { Role } from '../src/generated/prisma/enums'

/**
 * Fase 3, subpaso 3.1: permisos del crédito, códigos de error y reglas ESTRICTAS del método CREDITO en los pagos.
 * Todo es lógica pura: no toca la base de datos (por eso esta prueba no necesita el guard de entorno).
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const intenta = (f: () => unknown) => { try { f(); return null } catch (e) { return e as BusinessError & { message: string } } }
const codigo = (f: () => unknown) => intenta(f)?.code ?? null

const CRED: Permiso[] = ['credito.otorgar', 'credito.cobrar', 'credito.limite', 'credito.castigar']
const ROLES: Role[] = ['OWNER', 'ADMIN', 'VENDEDOR', 'CAJERO', 'ALMACENERO', 'CONTADOR']

console.log('\n1) Los cuatro permisos del crédito y quién los tiene')
check('>>> existen los 4 permisos, con etiqueta para la UI', CRED.every((p) => (PERMISOS as readonly string[]).includes(p) && ETIQUETAS[p].length > 8))
check('>>> el DUEÑO y el ADMIN tienen los cuatro', CRED.every((p) => permisosDeRol('OWNER').has(p) && permisosDeRol('ADMIN').has(p)))
check('>>> el CAJERO solo trae de fábrica «registrar abonos» (credito.cobrar)', CRED.filter((p) => permisosDeRol('CAJERO').has(p)).join() === 'credito.cobrar')
check('>>> el CAJERO puede recibir «fiar» (credito.otorgar) SOLO si el dueño lo activa: es opcional y no viene de fábrica',
  esOpcional('CAJERO', 'credito.otorgar') && !permisosDeRol('CAJERO').has('credito.otorgar') && permisosEfectivos(['CAJERO'], ['credito.otorgar']).has('credito.otorgar'))
check('>>> el VENDEDOR no puede fiar ni siquiera activándolo (no cobra, no tendría dónde usarlo)', !alcanzable('VENDEDOR', 'credito.otorgar'))
check('>>> subir la línea (credito.limite) y castigar deuda (credito.castigar) NO son alcanzables para nadie salvo dueño y admin',
  (['VENDEDOR', 'CAJERO', 'ALMACENERO', 'CONTADOR'] as Role[]).every((r) => !alcanzable(r, 'credito.limite') && !alcanzable(r, 'credito.castigar')))
check('ALMACENERO y CONTADOR no tienen ningún permiso de crédito, ni opcional', (['ALMACENERO', 'CONTADOR'] as Role[]).every((r) => CRED.every((p) => !alcanzable(r, p))))
check('ADMIN sigue siendo todo menos config.fiscal y plan.gestionar (el crédito no cambió esa regla)', permisosDeRol('ADMIN').size === PERMISOS.length - 2)
check('los opcionales declarados existen en el catálogo', Object.values(OPCIONALES).flat().every((p) => (PERMISOS as readonly string[]).includes(p)))
check('la matriz no concede permisos de crédito inventados', ROLES.every((r) => MATRIZ[r].every((p) => (PERMISOS as readonly string[]).includes(p))))

console.log('\n2) El PIN de cajero no abre decisiones de administración del crédito')
check('>>> credito.limite y credito.castigar están vedados al PIN', PERMISOS_FUERA_DEL_PIN.includes('credito.limite') && PERMISOS_FUERA_DEL_PIN.includes('credito.castigar'))
const sesionDueno = new Set<Permiso>(PERMISOS)
const denegados = permisosDenegadosAlOperador(sesionDueno)
check('>>> aunque la sesión del dispositivo sea del dueño, un operador por PIN queda sin límite ni castigo, pero conserva cobrar y fiar',
  denegados.includes('credito.limite') && denegados.includes('credito.castigar') && !denegados.includes('credito.cobrar') && !denegados.includes('credito.otorgar'))

console.log('\n3) Códigos de error nuevos')
const fuenteErr = readFileSync('src/lib/errors.ts', 'utf8')
check('>>> CREDIT_LIMIT, CREDIT_BLOCKED y CREDIT_CUSTOMER existen y se pueden lanzar con detalles', ['CREDIT_LIMIT', 'CREDIT_BLOCKED', 'CREDIT_CUSTOMER'].every((c) => fuenteErr.includes(`| '${c}'`))
  && new BusinessError('CREDIT_LIMIT', 'x', { limite: 1, deuda: 0, monto: 2, disponible: 1 }).details?.disponible === 1)

console.log('\n4) Reglas estrictas del método CREDITO (lógica pura)')
const conCliente = { conCliente: true, documentType: 'NOTA_VENTA' }
const P = (method: MetodoPago, amount: number) => ({ method, amount })
const ok = resolverPagos(100, [P('CREDITO', 100)], conCliente)
check('>>> todo a crédito: 100 fiados sobre 100, cuadra exacto, sin vuelto', ok.credito === 100 && ok.vuelto === 0 && ok.pagado === 100 && ok.pagos[0]!.change === 0)
const mixto = resolverPagos(100, [P('EFECTIVO', 30), P('YAPE', 20), P('CREDITO', 50)], conCliente)
check('>>> mixto: adelanto en efectivo + Yape + resto fiado = total exacto; lo fiado es solo la línea CREDITO', mixto.credito === 50 && mixto.vuelto === 0 && mixto.pagos.every((p) => p.change === 0))
check('sin fiado, el resultado trae credito = 0 y todo lo anterior sigue igual', resolverPagos(100, [P('EFECTIVO', 120)]).credito === 0 && resolverPagos(100, [P('EFECTIVO', 120)]).vuelto === 20)
check('>>> sin cliente identificado → CREDIT_CUSTOMER con mensaje claro (no se fía a «público general»)', intenta(() => resolverPagos(100, [P('CREDITO', 100)]))?.code === 'CREDIT_CUSTOMER'
  && intenta(() => resolverPagos(100, [P('CREDITO', 100)], { conCliente: false }))?.message === MENSAJE_FIADO_CLIENTE)
check('>>> con FACTURA → rechazado (la factura a crédito necesita cuotas que no están soportadas)', intenta(() => resolverPagos(100, [P('CREDITO', 100)], { conCliente: true, documentType: 'FACTURA' }))?.message === MENSAJE_FIADO_FACTURA)
check('con BOLETA o NOTA_VENTA sí', ['BOLETA', 'NOTA_VENTA', 'TICKET'].every((d) => codigo(() => resolverPagos(100, [P('CREDITO', 100)], { conCliente: true, documentType: d })) === null))
check('>>> dos líneas de crédito → rechazado', intenta(() => resolverPagos(100, [P('CREDITO', 50), P('CREDITO', 50)], conCliente))?.message === MENSAJE_FIADO_UNA_LINEA)
check('>>> fiado con sobrepago en efectivo (vuelto) → rechazado: con fiado el total cuadra exacto', intenta(() => resolverPagos(100, [P('EFECTIVO', 80), P('CREDITO', 50)], conCliente))?.message === MENSAJE_FIADO_EXACTO)
check('>>> fiado que no cubre el total → «los pagos no cubren el total» (INSUFFICIENT_STOCK, como siempre)', codigo(() => resolverPagos(100, [P('EFECTIVO', 30), P('CREDITO', 50)], conCliente)) === 'INSUFFICIENT_STOCK')
check('una línea de crédito en cero o con 3 decimales sigue siendo inválida', codigo(() => resolverPagos(100, [P('CREDITO', 0), P('EFECTIVO', 100)], conCliente)) === 'INVALID_DOCUMENT' && codigo(() => resolverPagos(100, [P('CREDITO', 100.005)], conCliente)) === 'INVALID_DOCUMENT')

console.log('\n5) Propiedad: miles de combinaciones con y sin fiado')
const METODOS: MetodoPago[] = ['EFECTIVO', 'TARJETA_DEBITO', 'TARJETA_CREDITO', 'TRANSFERENCIA', 'YAPE', 'PLIN', 'OTRO', 'CREDITO']
const DOCS = ['NOTA_VENTA', 'BOLETA', 'FACTURA', 'TICKET']
let semilla = 20261125
const azar = (n: number) => { semilla = (semilla * 1664525 + 1013904223) % 4294967296; return Math.floor((semilla / 4294967296) * n) }
let aceptados = 0, rechazados = 0, conFiado = 0, malos: string[] = []
for (let i = 0; i < 8000; i++) {
  const T = 1 + azar(50000)
  const n = 1 + azar(4)
  const caso = azar(100)
  const delta = caso < 12 ? -(1 + azar(Math.min(T, 3000))) : caso < 62 ? 0 : caso < 85 ? 1 + azar(3000) : 1 + azar(30000)
  const objetivo = Math.max(n, T + delta)
  const cortes = Array.from({ length: n - 1 }, () => 1 + azar(Math.max(1, objetivo - 1))).sort((a, b) => a - b)
  const partes = [...cortes, objetivo].map((c, k, arr) => Math.max(1, c - (k === 0 ? 0 : arr[k - 1]!)))
  const pagos = partes.map((c) => ({ method: METODOS[azar(METODOS.length)]!, amount: c / 100 }))
  const cliente = azar(100) < 80
  const doc = DOCS[azar(DOCS.length)]!
  // Oráculo independiente, en el orden de precedencia documentado.
  const S = partes.reduce((s, c) => s + c, 0)
  const C = pagos.reduce((s, p, k) => (p.method === 'EFECTIVO' ? s + partes[k]! : s), 0)
  const nCred = pagos.filter((p) => p.method === 'CREDITO').length
  const esperado: string | null =
    nCred > 1 ? 'INVALID_DOCUMENT'
    : nCred === 1 && !cliente ? 'CREDIT_CUSTOMER'
    : nCred === 1 && doc === 'FACTURA' ? 'INVALID_DOCUMENT'
    : S < T ? 'INSUFFICIENT_STOCK'
    : nCred === 1 && S > T ? 'INVALID_DOCUMENT'
    : S - T > C ? 'INVALID_DOCUMENT'
    : null
  let r: ReturnType<typeof resolverPagos> | null = null
  let err: string | null = null
  try { r = resolverPagos(T / 100, pagos, { conCliente: cliente, documentType: doc }) } catch (e) { err = (e as BusinessError).code }
  if (err !== esperado) { malos.push(`#${i} esperaba ${esperado} y dio ${err} (T=${T} S=${S} n=${nCred} cliente=${cliente} doc=${doc})`); continue }
  if (!r) { rechazados++; continue }
  aceptados++
  if (nCred === 1) conFiado++
  const cred = pagos.reduce((s, p, k) => (p.method === 'CREDITO' ? s + partes[k]! : s), 0)
  const neto = r.pagos.reduce((s, p) => s + Math.round(p.amount * 100) - Math.round(p.change * 100), 0)
  const ok2 = neto === T && Math.round(r.credito * 100) === cred && (nCred === 0 || (r.vuelto === 0 && S === T)) && r.pagos.every((p) => p.change >= 0 && p.change <= p.amount && (p.change === 0 || p.method === 'EFECTIVO'))
  if (!ok2) malos.push(`#${i} invariante T=${T} S=${S}`)
}
check(`>>> ${aceptados + rechazados} combinaciones: el código y un oráculo independiente coinciden en CUÁNDO se acepta y con QUÉ código se rechaza; y todo aceptado cuadra al céntimo`,
  malos.length === 0 && aceptados > 1500 && rechazados > 1500 && conFiado > 300, `${aceptados} aceptadas (${conFiado} con fiado) / ${rechazados} rechazadas ${malos.slice(0, 3).join('; ')}`)

console.log('\n6) El esquema de la venta')
const base = { warehouseId: 'w', items: [{ productId: 'p', quantity: 1 }] }
const esq = (customerId: string | null | undefined) => registerSaleSchema.safeParse({ ...base, customerId, payments: [{ method: 'CREDITO', amount: 100 }] })
check('>>> el esquema ya acepta CREDITO, pero pide cliente: sin cliente el cajero recibe el mensaje claro', !esq(undefined).success && !esq(null).success
  && JSON.stringify(esq(undefined).error?.issues).includes('DNI o RUC'))
check('con cliente el esquema lo deja pasar (las reglas de fondo las aplican el servicio y la base)', esq('cliente-1').success)
check('un pago sin fiado no pide cliente (nada cambió para las ventas de siempre)', registerSaleSchema.safeParse({ ...base, payments: [{ method: 'EFECTIVO', amount: 100 }] }).success)

console.log('\n7) registerSale aplica las reglas y registra la deuda en la misma transacción')
const venta = readFileSync('src/features/pos/sale-service.ts', 'utf8')
check('>>> registerSale valida las reglas del fiado con cliente y comprobante, exige el permiso credito.otorgar y registra la deuda con otorgarCredito',
  /resolverPagos\(total, input\.payments, \{ conCliente: !!input\.customerId, documentType: input\.documentType \}\)/.test(venta)
  && /credito > 0 && !puede\(ctx, 'credito\.otorgar'\)/.test(venta) && /otorgarCredito\(t, ctx,/.test(venta))
check('>>> la deuda nace DESPUÉS de crear la venta y los pagos y ANTES del stock: si el stock falla, se deshace todo junto',
  venta.indexOf('t.payment.createMany') < venta.indexOf('otorgarCredito(t, ctx,') && venta.indexOf('otorgarCredito(t, ctx,') < venta.indexOf('applyStockMovement(t, ctx,'))

console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
process.exit(fail === 0 ? 0 : 1)
