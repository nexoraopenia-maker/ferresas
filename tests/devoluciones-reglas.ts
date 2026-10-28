import { CODIGO_NOTA, efectivoDelCajon, ESTADO_FINAL, necesitaCaja, pagadoNeto, planDeComprobante, planDeCredito, productosDadosDeBaja, reembolsosPorDefecto, validarReembolsos } from '../src/features/devoluciones/reglas'
import { anularOdevolverVentaSchema } from '../src/features/devoluciones/schemas'
import { ventasQueRompenElCheck } from '../src/features/devoluciones/verificacion'

/**
 * F6.1 · Reglas de la anulación / devolución (funciones puras): lo pagado de verdad, adónde va el dinero, qué se hace con el comprobante,
 * qué pasa con una venta fiada y con un producto dado de baja.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
let semilla = 3
const rnd = () => { semilla = (semilla * 1103515245 + 12345) % 2147483648; return semilla / 2147483648 }

console.log('\nA) Lo que el cliente pagó de verdad')
check('>>> efectivo 200 sin vuelto → neto 200.00', pagadoNeto([{ method: 'EFECTIVO', amount: 200, change: 0 }]).netoCent === 20000)
check('>>> pagó 130 en efectivo con vuelto 5 → neto 125.00 (el vuelto no se devuelve)', pagadoNeto([{ method: 'EFECTIVO', amount: 130, change: 5 }]).netoCent === 12500)
const mixto = pagadoNeto([{ method: 'EFECTIVO', amount: 100, change: 0 }, { method: 'YAPE', amount: 25, change: 0 }, { method: 'CREDITO', amount: 75, change: 0 }])
check('>>> mixto: el fiado NO es dinero pagado: neto 125 (100 efectivo + 25 Yape) y fiado 75', mixto.netoCent === 12500 && mixto.fiadoCent === 7500 && mixto.porMedio.length === 2)
check('todo fiado → neto 0', pagadoNeto([{ method: 'CREDITO', amount: 500, change: 0 }]).netoCent === 0)
check('>>> varias líneas del mismo medio se suman', pagadoNeto([{ method: 'YAPE', amount: 10, change: 0 }, { method: 'YAPE', amount: 15.5, change: 0 }]).porMedio[0]!.cent === 2550)

console.log('\nB) Reembolsos')
check('>>> por defecto el efectivo sale del CAJÓN y lo demás por fuera, con su medio', JSON.stringify(reembolsosPorDefecto(mixto).map((r) => `${r.mode}:${r.method}:${r.amount}`)) === JSON.stringify(['CAJA:EFECTIVO:100', 'EXTERNO:YAPE:25']))
const ok = (e: Parameters<typeof validarReembolsos>[0], p = mixto) => validarReembolsos(e, p)
check('sin reembolsos explícitos se usan los de por defecto', ok(undefined).ok && ok([]).ok && (ok(undefined) as { reembolsos: unknown[] }).reembolsos.length === 2)
check('>>> el efectivo devuelto por Yape (cambiar el destino) es válido si suma lo pagado', ok([{ mode: 'EXTERNO', method: 'YAPE', amount: 125 }]).ok)
check('>>> «sin salida de dinero» exige motivo de 3 a 120 caracteres', !ok([{ mode: 'CAJA', amount: 100 }, { mode: 'SIN_SALIDA', amount: 25 }]).ok && !ok([{ mode: 'CAJA', amount: 100 }, { mode: 'SIN_SALIDA', amount: 25, reference: 'ab' }]).ok && !ok([{ mode: 'CAJA', amount: 100 }, { mode: 'SIN_SALIDA', amount: 25, reference: 'x'.repeat(121) }]).ok && ok([{ mode: 'CAJA', amount: 100 }, { mode: 'SIN_SALIDA', amount: 25, reference: 'Crédito en tienda acordado' }]).ok)
check('>>> la suma de TODOS los reembolsos (incluida la que no sale) debe ser lo pagado: 120 o 130 sobre 125 se rechaza, con el mensaje', (() => { const a = ok([{ mode: 'CAJA', amount: 120 }]), b = ok([{ mode: 'CAJA', amount: 130 }]); return !a.ok && !b.ok && (a as { mensaje: string }).mensaje.includes('125.00') })())
check('>>> lo que sale del cajón es siempre efectivo; un medio distinto en CAJA se rechaza', !ok([{ mode: 'CAJA', method: 'YAPE', amount: 125 }]).ok)
check('>>> por fuera del cajón exige un medio que no sea efectivo ni crédito', !ok([{ mode: 'EXTERNO', amount: 125 }]).ok && !ok([{ mode: 'EXTERNO', method: 'EFECTIVO', amount: 125 }]).ok && !ok([{ mode: 'EXTERNO', method: 'CREDITO', amount: 125 }]).ok && ok([{ mode: 'EXTERNO', method: 'TRANSFERENCIA', amount: 125 }]).ok)
check('importes: cero, negativos, NaN y más de 2 decimales se rechazan', [0, -5, NaN, 12.345].every((m) => !ok([{ mode: 'CAJA', amount: m }]).ok))
check('>>> una venta toda fiada no admite reembolsos (no hay dinero) y sin pedirlos queda en cero', !validarReembolsos([{ mode: 'CAJA', amount: 10 }], pagadoNeto([{ method: 'CREDITO', amount: 500, change: 0 }])).ok && (() => { const r = validarReembolsos(undefined, pagadoNeto([{ method: 'CREDITO', amount: 500, change: 0 }])); return r.ok && r.reembolsos.length === 0 })())
check('necesitaCaja y efectivoDelCajon solo miran los reembolsos CAJA', (() => { const r = (ok(undefined) as { reembolsos: Parameters<typeof necesitaCaja>[0] }).reembolsos; return necesitaCaja(r) && efectivoDelCajon(r) === 100 && !necesitaCaja([{ mode: 'EXTERNO', method: 'YAPE', amount: 5, reference: null }]) })())
check('>>> 300 casos al azar: los reembolsos por defecto suman SIEMPRE lo pagado, al céntimo', (() => {
  const medios = ['EFECTIVO', 'YAPE', 'PLIN', 'TRANSFERENCIA', 'TARJETA_DEBITO', 'CREDITO'] as const
  for (let i = 0; i < 300; i++) {
    const pagos = Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => { const amount = Math.round(rnd() * 100000) / 100; const m = medios[Math.floor(rnd() * 6)]!; return { method: m, amount, change: m === 'EFECTIVO' && rnd() < 0.4 ? Math.round(rnd() * amount * 100) / 100 : 0 } })
    const p = pagadoNeto(pagos), r = validarReembolsos(undefined, p)
    if (!r.ok || r.reembolsos.reduce((a, x) => a + Math.round(x.amount * 100), 0) !== p.netoCent) return false
  }
  return true
})())

console.log('\nC) Comprobante')
const doc = (estado: Parameters<typeof planDeComprobante>[0] extends infer T ? (T extends { estado: infer E } ? E : never) : never, isTrial = false) => ({ estado, isTrial, numero: 'B001-00000007' })
check('>>> sin comprobante (nota de venta) → nada', planDeComprobante(null, 'DEVOLUCION').accion === 'NINGUNA')
check('>>> ACEPTADO → nota de crédito total: 01 al anular, 06 al devolver', JSON.stringify(planDeComprobante(doc('ACEPTADO'), 'ANULACION')) === '{"accion":"EMITIR_NOTA","codigo":"01"}' && JSON.stringify(planDeComprobante(doc('ACEPTADO'), 'DEVOLUCION')) === '{"accion":"EMITIR_NOTA","codigo":"06"}')
check('>>> OBSERVADO también (es válido y suma en el registro): nota de crédito', planDeComprobante(doc('OBSERVADO'), 'DEVOLUCION').accion === 'EMITIR_NOTA')
check('>>> PENDIENTE y ENVIADO → BLOQUEA, diciendo que sigue en la cola fiscal y cuál es el comprobante', ['PENDIENTE', 'ENVIADO'].every((e) => { const p = planDeComprobante(doc(e as never), 'DEVOLUCION'); return p.accion === 'BLOQUEAR' && p.mensaje.includes('cola fiscal') && p.mensaje.includes('B001-00000007') }))
check('>>> RECHAZADO y ANULADO (ya no están vivos) → sin nota', planDeComprobante(doc('RECHAZADO'), 'DEVOLUCION').accion === 'NINGUNA' && planDeComprobante(doc('ANULADO'), 'DEVOLUCION').accion === 'NINGUNA')
check('>>> de ensayo → se marca, sin nota, sea cual sea su estado (incluso pendiente)', ['ACEPTADO', 'PENDIENTE', 'ENVIADO'].every((e) => planDeComprobante(doc(e as never, true), 'DEVOLUCION').accion === 'MARCAR_ENSAYO'))
check('constantes: estado final y código por tipo', ESTADO_FINAL.ANULACION === 'ANULADA' && ESTADO_FINAL.DEVOLUCION === 'DEVUELTA' && CODIGO_NOTA.ANULACION === '01' && CODIGO_NOTA.DEVOLUCION === '06')

console.log('\nD) Crédito')
check('sin cuenta → nada', planDeCredito(null, []).accion === 'NINGUNA')
check('>>> cuenta abierta SIN abonos → se cancela por el monto fiado', JSON.stringify(planDeCredito({ status: 'ABIERTA', amount: 200, paidAmount: 0 }, [])) === '{"accion":"CANCELAR_CUENTA","montoCent":20000}')
check('>>> con abonos → BLOQUEA, nombrando cada abono (fecha, monto y medio) y cómo proceder', (() => { const p = planDeCredito({ status: 'ABIERTA', amount: 200, paidAmount: 50 }, [{ fecha: '2026-10-20', monto: 30, metodo: 'EFECTIVO' }, { fecha: '2026-10-22', monto: 20, metodo: 'YAPE' }]); return p.accion === 'BLOQUEAR' && p.mensaje.includes('2026-10-20: S/ 30.00') && p.mensaje.includes('2026-10-22: S/ 20.00') && p.mensaje.includes('anula esos abonos') })())
check('>>> una cuenta pagada del todo también tiene abonos → bloquea', planDeCredito({ status: 'PAGADA', amount: 200, paidAmount: 200 }, []).accion === 'BLOQUEAR')
check('una cuenta ya dada de baja y sin abonos → nada que hacer; con abonos aplicados → bloquea', planDeCredito({ status: 'ANULADA', amount: 200, paidAmount: 0 }, []).accion === 'NINGUNA' && planDeCredito({ status: 'ANULADA', amount: 200, paidAmount: 40 }, []).accion === 'BLOQUEAR')

console.log('\nE) Productos dados de baja y esquema')
check('>>> solo cuentan los productos CON control de stock dados de baja, sin repetir', JSON.stringify(productosDadosDeBaja([{ nombre: 'Cemento', trackStock: true, dadoDeBaja: true }, { nombre: 'Cemento', trackStock: true, dadoDeBaja: true }, { nombre: 'Servicio', trackStock: false, dadoDeBaja: true }, { nombre: 'Arena', trackStock: true, dadoDeBaja: false }])) === '["Cemento"]')
const base = { saleId: 's1', kind: 'DEVOLUCION', reason: 'El cliente se arrepintió', idempotencyKey: '3b1f1c2e-4a5d-4e6f-8a9b-0c1d2e3f4a5b' }
check('el esquema pide tipo, motivo (3–250) y clave; el cliente no manda importes de la venta', anularOdevolverVentaSchema.safeParse(base).success && !anularOdevolverVentaSchema.safeParse({ ...base, reason: 'ab' }).success && !anularOdevolverVentaSchema.safeParse({ ...base, reason: 'x'.repeat(251) }).success && !anularOdevolverVentaSchema.safeParse({ ...base, kind: 'OTRA' }).success && !anularOdevolverVentaSchema.safeParse({ ...base, idempotencyKey: 'no' }).success)
check('el esquema acota los reembolsos (modo válido, importe positivo, máximo 8)', anularOdevolverVentaSchema.safeParse({ ...base, refunds: [{ mode: 'CAJA', amount: 10 }] }).success && !anularOdevolverVentaSchema.safeParse({ ...base, refunds: [{ mode: 'XX', amount: 10 }] }).success && !anularOdevolverVentaSchema.safeParse({ ...base, refunds: [{ mode: 'CAJA', amount: 0 }] }).success && !anularOdevolverVentaSchema.safeParse({ ...base, refunds: Array.from({ length: 9 }, () => ({ mode: 'CAJA', amount: 1 })) }).success)

void (async () => {
console.log('\nF) La comprobación previa a la migración (solo lectura)')
const fila = (o: Partial<Parameters<typeof ventasQueRompenElCheck>[0] extends never ? never : { tenantId: string; number: string; status: string; voidedAt: Date | null; voidReason: string | null }> = {}) => ({ tenantId: 't', number: 'V1', status: 'ANULADA', voidedAt: new Date(), voidReason: 'Error', ...o })
const lector = (filas: ReturnType<typeof fila>[]) => ({ sale: { findMany: async () => filas } })
check('>>> sin fecha, sin motivo (nulo), motivo vacío o en blanco → rompen el CHECK; fecha y motivo válidos → no', await (async () => {
  const r = await ventasQueRompenElCheck(lector([fila({ number: 'A', voidedAt: null }), fila({ number: 'B', voidReason: null }), fila({ number: 'C', voidReason: '' }), fila({ number: 'D', voidReason: '   ' }), fila({ number: 'E' })]))
  return r.map((x) => x.number).join() === 'A,B,C,D'
})())
check('la consulta pide solo ANULADA y DEVUELTA', await (async () => { let args = ''; await ventasQueRompenElCheck({ sale: { findMany: async (a) => { args = JSON.stringify(a.where); return [] } } }); return args === '{"status":{"in":["ANULADA","DEVUELTA"]}}' })())

console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
process.exit(fail === 0 ? 0 : 1)
})()
