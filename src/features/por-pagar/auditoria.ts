import type { TenantPrismaClient } from '@/lib/tenant-prisma'

/**
 * Auditoría de coherencia de compras y cuentas por pagar. SOLO LECTURA: no escribe, no corrige, no recalcula nada.
 *
 * Compras y deudas con proveedores guardan la misma verdad en varios sitios a propósito (la deuda del proveedor es una caché de sus
 * cuentas; lo pagado de una cuenta es la suma de sus repartos; cada compra recibida dejó su stock; el cierre de caja congela totales).
 * Cada transacción las mantiene al día y los CHECK de la base impiden los estados imposibles, pero ningún CHECK compara tablas.
 * Esto las compara — incluidos los invariantes que el esquema de F4.1 dejó expresamente para aquí: que el proveedor de la cuenta sea el
 * de la compra y que el de un pago sea el de la cuenta a la que se aplica.
 *
 * Todo ERROR: aquí no hay situaciones «legítimas pero raras» como el fiado revisado por una nota de crédito. Todo se compara en
 * céntimos enteros (y el stock en diezmilésimas): dos decimales de coma flotante no se comparan con ===.
 */

export type CodigoHallazgoPorPagar =
  | 'DEUDA_PROVEEDOR'
  | 'PAGADO_CUENTA'
  | 'REPARTO_PAGO'
  | 'REPARTO_PROVEEDOR'
  | 'CUENTA_COMPRA_PROVEEDOR'
  | 'CUENTA_COMPRA_MONTO'
  | 'COMPRA_CREDITO_SIN_CUENTA'
  | 'COMPRA_CONTADO_CON_CUENTA'
  | 'CUENTA_ESTADO_COMPRA'
  | 'STOCK_COMPRA'
  | 'CIERRE_PAGOS'
  | 'CIERRE_ESPERADO'

export interface HallazgoPorPagar {
  codigo: CodigoHallazgoPorPagar
  gravedad: 'ERROR'
  entidad: 'proveedor' | 'cuenta' | 'pago' | 'compra' | 'turno'
  id: string
  nombre: string
  detalle: string
  esperado?: number
  encontrado?: number
}

export interface DatosPorPagar {
  proveedores: { id: string; name: string; payableBalance: number }[]
  cuentas: { id: string; supplierId: string; purchaseId: string; amount: number; paidAmount: number; status: 'ABIERTA' | 'PAGADA' | 'ANULADA' }[]
  pagos: { id: string; supplierId: string; amount: number; method: string; anulado: boolean; cashSessionId: string | null }[]
  repartos: { paymentId: string; payableId: string; amount: number }[]
  compras: {
    id: string; number: string; status: 'BORRADOR' | 'RECIBIDA' | 'ANULADA'; supplierId: string | null
    paymentCondition: 'CONTADO' | 'CREDITO'; total: number; recibida: boolean
  }[]
  lineas: { purchaseId: string; productId: string; quantity: number }[]
  /** Movimientos de stock con referencia a una compra. `quantity` con signo (la devolución es negativa). */
  movimientos: { purchaseId: string; productId: string; type: string; quantity: number }[]
  turnosCerrados: {
    id: string; openingAmount: number; expectedAmount: number; cashTotal: number; cashReceiptsTotal: number; changeTotal: number
    supplierCashPaymentsTotal: number; supplierOtherPaymentsTotal: number
  }[]
}

export interface InformePorPagar {
  proveedores: number
  cuentas: number
  pagos: number
  compras: number
  turnosCerrados: number
  hallazgos: HallazgoPorPagar[]
  errores: number
}

const c = (n: number) => Math.round(n * 100)
const s = (cent: number) => cent / 100
const q = (n: number) => Math.round(n * 10_000)
const soles = (n: number) => `S/ ${n.toFixed(2)}`

export function auditarDatosPorPagar(d: DatosPorPagar): InformePorPagar {
  const hallazgos: HallazgoPorPagar[] = []
  const hay = (
    codigo: CodigoHallazgoPorPagar, entidad: HallazgoPorPagar['entidad'], id: string, nombre: string, detalle: string,
    importes?: { esperado: number; encontrado: number },
  ) => hallazgos.push({ codigo, gravedad: 'ERROR', entidad, id, nombre, detalle, ...importes })

  const pagoPorId = new Map(d.pagos.map((p) => [p.id, p]))
  const cuentaPorId = new Map(d.cuentas.map((x) => [x.id, x]))
  const compraPorId = new Map(d.compras.map((x) => [x.id, x]))
  const cuentaDeCompra = new Map(d.cuentas.map((x) => [x.purchaseId, x]))

  // 1) La deuda del proveedor es la suma de los saldos de sus cuentas ABIERTAS.
  for (const p of d.proveedores) {
    const suma = d.cuentas.filter((x) => x.supplierId === p.id && x.status === 'ABIERTA').reduce((a, x) => a + c(x.amount) - c(x.paidAmount), 0)
    if (c(p.payableBalance) !== suma) {
      hay('DEUDA_PROVEEDOR', 'proveedor', p.id, p.name, `La deuda guardada (${soles(p.payableBalance)}) no es la suma de los saldos de sus cuentas abiertas (${soles(s(suma))}).`,
        { esperado: s(suma), encontrado: p.payableBalance })
    }
  }

  // 2) Lo pagado de una cuenta es la suma de sus repartos de pagos NO anulados.
  const vivos = new Map<string, number>()
  for (const r of d.repartos) {
    if (pagoPorId.get(r.paymentId)?.anulado) continue
    vivos.set(r.payableId, (vivos.get(r.payableId) ?? 0) + c(r.amount))
  }
  for (const x of d.cuentas) {
    const suma = vivos.get(x.id) ?? 0
    if (c(x.paidAmount) !== suma) {
      hay('PAGADO_CUENTA', 'cuenta', x.id, compraPorId.get(x.purchaseId)?.number ?? x.purchaseId,
        `Lo pagado de la cuenta (${soles(x.paidAmount)}) no es la suma de sus repartos vigentes (${soles(s(suma))}).`, { esperado: s(suma), encontrado: x.paidAmount })
    }
  }

  // 3) Un pago se reparte por completo: Σ repartos = monto (también los anulados: se conservan).
  const repartido = new Map<string, number>()
  for (const r of d.repartos) repartido.set(r.paymentId, (repartido.get(r.paymentId) ?? 0) + c(r.amount))
  for (const p of d.pagos) {
    const rep = repartido.get(p.id) ?? 0
    if (c(p.amount) !== rep) hay('REPARTO_PAGO', 'pago', p.id, p.id, `El pago es de ${soles(p.amount)} pero sus repartos suman ${soles(s(rep))}.`, { esperado: p.amount, encontrado: s(rep) })
  }

  // 4) Un pago solo paga cuentas de su propio proveedor (las llaves foráneas compuestas son por negocio, no por proveedor).
  for (const r of d.repartos) {
    const p = pagoPorId.get(r.paymentId), x = cuentaPorId.get(r.payableId)
    if (p && x && p.supplierId !== x.supplierId) hay('REPARTO_PROVEEDOR', 'pago', p.id, p.id, `Un reparto de ${soles(r.amount)} cae en una cuenta de OTRO proveedor.`)
  }

  // 5) Cuenta ↔ compra: el proveedor y el monto son los de la compra; y los estados dicen lo mismo.
  for (const x of d.cuentas) {
    const v = compraPorId.get(x.purchaseId)
    if (!v) { hay('CUENTA_ESTADO_COMPRA', 'cuenta', x.id, x.purchaseId, 'La cuenta apunta a una compra que no existe.'); continue }
    if (v.supplierId !== x.supplierId) hay('CUENTA_COMPRA_PROVEEDOR', 'cuenta', x.id, v.number, 'La cuenta es de un proveedor distinto al de la compra.')
    if (c(x.amount) !== c(v.total)) hay('CUENTA_COMPRA_MONTO', 'cuenta', x.id, v.number, `La cuenta es de ${soles(x.amount)} y la compra de ${soles(v.total)}.`, { esperado: v.total, encontrado: x.amount })
    if (v.paymentCondition === 'CONTADO') hay('COMPRA_CONTADO_CON_CUENTA', 'cuenta', x.id, v.number, 'Hay una cuenta por pagar pero la compra es al contado.')
    if (v.status === 'ANULADA' && x.status !== 'ANULADA') hay('CUENTA_ESTADO_COMPRA', 'cuenta', x.id, v.number, `La compra está ANULADA pero su cuenta está ${x.status}.`)
    if (v.status === 'RECIBIDA' && x.status === 'ANULADA') hay('CUENTA_ESTADO_COMPRA', 'cuenta', x.id, v.number, 'La compra está RECIBIDA pero su cuenta está ANULADA.')
    if (v.status === 'BORRADOR') hay('CUENTA_ESTADO_COMPRA', 'cuenta', x.id, v.number, 'Hay una cuenta por pagar de una compra que sigue en borrador.')
  }
  for (const v of d.compras) {
    if (v.status === 'RECIBIDA' && v.paymentCondition === 'CREDITO' && !cuentaDeCompra.has(v.id)) {
      hay('COMPRA_CREDITO_SIN_CUENTA', 'compra', v.id, v.number, `La compra a crédito se recibió (${soles(v.total)}) pero no tiene cuenta por pagar.`, { esperado: v.total, encontrado: 0 })
    }
  }

  // 6) Stock ↔ compra: lo recibido dejó UNA entrada por línea; lo anulado después dejó su devolución; un borrador o una anulada sin recibir, nada.
  const lineas = new Map<string, number>()
  for (const l of d.lineas) lineas.set(`${l.purchaseId}|${l.productId}`, (lineas.get(`${l.purchaseId}|${l.productId}`) ?? 0) + q(l.quantity))
  const mov = (tipo: string) => {
    const m = new Map<string, number>()
    for (const x of d.movimientos) if (x.type === tipo) m.set(`${x.purchaseId}|${x.productId}`, (m.get(`${x.purchaseId}|${x.productId}`) ?? 0) + q(x.quantity))
    return m
  }
  const entradas = mov('ENTRADA'), devoluciones = mov('DEVOLUCION_PROVEEDOR')
  for (const v of d.compras) {
    const llaves = new Set([...lineas.keys(), ...entradas.keys(), ...devoluciones.keys()].filter((k) => k.startsWith(`${v.id}|`)))
    const entro = v.recibida, salio = v.recibida && v.status === 'ANULADA'
    for (const k of llaves) {
      const esperadoEntrada = entro ? (lineas.get(k) ?? 0) : 0
      const esperadoSalida = salio ? -(lineas.get(k) ?? 0) : 0
      const hayEntrada = entradas.get(k) ?? 0, haySalida = devoluciones.get(k) ?? 0
      if (hayEntrada !== esperadoEntrada || haySalida !== esperadoSalida) {
        hay('STOCK_COMPRA', 'compra', v.id, v.number,
          `Producto ${k.split('|')[1]}: entradas ${hayEntrada / 10_000} (esperadas ${esperadoEntrada / 10_000}), devoluciones ${haySalida / 10_000} (esperadas ${esperadoSalida / 10_000}).`,
          { esperado: esperadoEntrada / 10_000, encontrado: hayEntrada / 10_000 })
      }
    }
  }

  // 7) Un turno CERRADO es inmutable: lo congelado de pagos = lo enlazado a él; y el esperado congelado es su propia fórmula.
  for (const t of d.turnosCerrados) {
    const propios = d.pagos.filter((p) => p.cashSessionId === t.id && !p.anulado)
    const ef = propios.filter((p) => p.method === 'EFECTIVO').reduce((a, p) => a + c(p.amount), 0)
    const ot = propios.filter((p) => p.method !== 'EFECTIVO').reduce((a, p) => a + c(p.amount), 0)
    if (c(t.supplierCashPaymentsTotal) !== ef || c(t.supplierOtherPaymentsTotal) !== ot) {
      hay('CIERRE_PAGOS', 'turno', t.id, t.id,
        `Congelado: pagos en efectivo ${soles(t.supplierCashPaymentsTotal)} y por otros medios ${soles(t.supplierOtherPaymentsTotal)}; enlazados al turno: ${soles(s(ef))} y ${soles(s(ot))}.`,
        { esperado: s(ef) + s(ot), encontrado: t.supplierCashPaymentsTotal + t.supplierOtherPaymentsTotal })
    }
    const esperado = c(t.openingAmount) + c(t.cashTotal) + c(t.cashReceiptsTotal) - c(t.changeTotal) - c(t.supplierCashPaymentsTotal)
    if (c(t.expectedAmount) !== esperado) {
      hay('CIERRE_ESPERADO', 'turno', t.id, t.id, `El efectivo esperado congelado (${soles(t.expectedAmount)}) no sale de sus propias columnas (${soles(s(esperado))}).`, { esperado: s(esperado), encontrado: t.expectedAmount })
    }
  }

  return {
    proveedores: d.proveedores.length, cuentas: d.cuentas.length, pagos: d.pagos.length, compras: d.compras.length, turnosCerrados: d.turnosCerrados.length,
    hallazgos, errores: hallazgos.length,
  }
}

const num = (v: unknown): number => Number(v?.toString() ?? 0)

/** Lee TODAS las compras y deudas del negocio del cliente Prisma recibido (aislado por negocio) y las audita. No escribe. */
export async function auditarCoherenciaPorPagar(db: TenantPrismaClient): Promise<InformePorPagar> {
  const [proveedores, cuentas, pagos, repartos, compras, lineas, movimientos, turnos] = await Promise.all([
    db.supplier.findMany({ select: { id: true, name: true, payableBalance: true } }),
    db.accountPayable.findMany({ select: { id: true, supplierId: true, purchaseId: true, amount: true, paidAmount: true, status: true } }),
    db.supplierPayment.findMany({ select: { id: true, supplierId: true, amount: true, method: true, voidedAt: true, cashSessionId: true } }),
    db.supplierPaymentAllocation.findMany({ select: { supplierPaymentId: true, payableId: true, amount: true } }),
    db.purchase.findMany({ select: { id: true, number: true, status: true, supplierId: true, paymentCondition: true, total: true, receivedAt: true } }),
    db.purchaseItem.findMany({ select: { purchaseId: true, productId: true, quantity: true } }),
    db.stockMovement.findMany({ where: { referenceType: 'COMPRA' }, select: { referenceId: true, productId: true, type: true, quantity: true } }),
    db.cashSession.findMany({
      where: { status: 'CERRADA' },
      select: { id: true, openingAmount: true, expectedAmount: true, cashTotal: true, cashReceiptsTotal: true, changeTotal: true, supplierCashPaymentsTotal: true, supplierOtherPaymentsTotal: true },
    }),
  ])
  return auditarDatosPorPagar({
    proveedores: proveedores.map((x) => ({ id: x.id, name: x.name, payableBalance: num(x.payableBalance) })),
    cuentas: cuentas.map((x) => ({ id: x.id, supplierId: x.supplierId, purchaseId: x.purchaseId, amount: num(x.amount), paidAmount: num(x.paidAmount), status: x.status })),
    pagos: pagos.map((p) => ({ id: p.id, supplierId: p.supplierId, amount: num(p.amount), method: p.method, anulado: p.voidedAt !== null, cashSessionId: p.cashSessionId })),
    repartos: repartos.map((r) => ({ paymentId: r.supplierPaymentId, payableId: r.payableId, amount: num(r.amount) })),
    compras: compras.map((v) => ({
      id: v.id, number: v.number, status: v.status, supplierId: v.supplierId, paymentCondition: v.paymentCondition, total: num(v.total), recibida: v.receivedAt !== null,
    })),
    lineas: lineas.map((l) => ({ purchaseId: l.purchaseId, productId: l.productId, quantity: num(l.quantity) })),
    movimientos: movimientos.flatMap((m) => (m.referenceId ? [{ purchaseId: m.referenceId, productId: m.productId, type: m.type, quantity: num(m.quantity) }] : [])),
    turnosCerrados: turnos.map((t) => ({
      id: t.id, openingAmount: num(t.openingAmount), expectedAmount: num(t.expectedAmount), cashTotal: num(t.cashTotal), cashReceiptsTotal: num(t.cashReceiptsTotal),
      changeTotal: num(t.changeTotal), supplierCashPaymentsTotal: num(t.supplierCashPaymentsTotal), supplierOtherPaymentsTotal: num(t.supplierOtherPaymentsTotal),
    })),
  })
}

export function formatearInformePorPagar(slug: string, i: InformePorPagar, detalle = false): string {
  const l = [`\n▌ ${slug} — ${i.proveedores} proveedor(es), ${i.compras} compra(s), ${i.cuentas} cuenta(s), ${i.pagos} pago(s), ${i.turnosCerrados} turno(s) cerrado(s): ${i.errores} error(es)`]
  const por = new Map<CodigoHallazgoPorPagar, HallazgoPorPagar[]>()
  for (const h of i.hallazgos) por.set(h.codigo, [...(por.get(h.codigo) ?? []), h])
  for (const [codigo, hs] of por) {
    l.push(`  ✗ ${codigo} (ERROR): ${hs.length}`)
    for (const h of detalle ? hs : hs.slice(0, 3)) l.push(`      · ${h.entidad} ${h.nombre} [${h.id}] — ${h.detalle}`)
    if (!detalle && hs.length > 3) l.push(`      · … y ${hs.length - 3} más (usa --detalle)`)
  }
  return l.join('\n')
}
