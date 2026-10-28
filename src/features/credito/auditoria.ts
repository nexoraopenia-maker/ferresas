import type { TenantPrismaClient } from '@/lib/tenant-prisma'

/**
 * Auditoría de coherencia del crédito. SOLO LECTURA: no escribe, no corrige, no recalcula nada.
 *
 * El crédito guarda la misma verdad en varios sitios a propósito (la deuda del cliente es una caché de sus cuentas; lo abonado de una
 * cuenta es la suma de sus repartos; el cierre de caja congela totales). Cada transacción las mantiene al día, y los CHECK de la
 * base impiden los estados imposibles, pero ningún CHECK puede comparar tablas. Esto las compara.
 *
 * Dos gravedades:
 *  · ERROR: la contabilidad del crédito no cuadra. Hay que investigar antes de seguir (algo escribió fuera de las reglas, o un bug).
 *  · AVISO: situación legítima pero que una persona debe mirar (una cuenta con nota de crédito por resolver, una venta anulada con
 *    deuda viva, un cierre cuyas ventas ya no suman lo congelado).
 *
 * Todo se compara en céntimos enteros: dos decimales de coma flotante no se comparan con ===.
 */

export type GravedadCredito = 'ERROR' | 'AVISO'

export type CodigoHallazgoCredito =
  | 'DEUDA_CLIENTE'
  | 'ABONADO_CUENTA'
  | 'REPARTO_ABONO'
  | 'REPARTO_CLIENTE'
  | 'VENTA_FIADA_SIN_CUENTA'
  | 'CUENTA_SIN_FIADO_EN_VENTA'
  | 'MONTO_CUENTA_VENTA'
  | 'CLIENTE_CUENTA_VENTA'
  | 'CIERRE_ABONOS'
  | 'CIERRE_FIADO'
  | 'VENTA_ANULADA_CUENTA_VIVA'
  | 'REVISION_PENDIENTE'

export const GRAVEDAD: Record<CodigoHallazgoCredito, GravedadCredito> = {
  DEUDA_CLIENTE: 'ERROR',
  ABONADO_CUENTA: 'ERROR',
  REPARTO_ABONO: 'ERROR',
  REPARTO_CLIENTE: 'ERROR',
  VENTA_FIADA_SIN_CUENTA: 'ERROR',
  CUENTA_SIN_FIADO_EN_VENTA: 'ERROR',
  MONTO_CUENTA_VENTA: 'ERROR',
  CLIENTE_CUENTA_VENTA: 'ERROR',
  CIERRE_ABONOS: 'ERROR',
  CIERRE_FIADO: 'AVISO',
  VENTA_ANULADA_CUENTA_VIVA: 'AVISO',
  REVISION_PENDIENTE: 'AVISO',
}

export interface HallazgoCredito {
  codigo: CodigoHallazgoCredito
  gravedad: GravedadCredito
  /** Qué se revisó: cliente, cuenta, abono, venta o turno. */
  entidad: 'cliente' | 'cuenta' | 'abono' | 'venta' | 'turno'
  id: string
  /** Nombre legible (cliente, nº de venta…). */
  nombre: string
  detalle: string
  /** En soles, cuando el hallazgo es un descuadre de importes. */
  esperado?: number
  encontrado?: number
}

/** Los datos, ya leídos y en números. Separado de la lectura para poder probar cada regla con datos fabricados. */
export interface DatosCredito {
  clientes: { id: string; name: string; creditBalance: number }[]
  cuentas: {
    id: string; customerId: string; saleId: string; amount: number; paidAmount: number
    status: 'ABIERTA' | 'PAGADA' | 'ANULADA'; enRevision: boolean
  }[]
  abonos: { id: string; customerId: string; amount: number; method: string; anulado: boolean; cashSessionId: string | null }[]
  repartos: { paymentId: string; receivableId: string; amount: number }[]
  /** Ventas con alguna línea CREDITO, o que tienen cuenta. `fiado` = Σ de sus líneas CREDITO. */
  ventas: { id: string; number: string; status: string; customerId: string | null; cashSessionId: string | null; fiado: number }[]
  turnosCerrados: { id: string; cashReceiptsTotal: number; otherReceiptsTotal: number; creditSalesTotal: number }[]
}

export interface InformeCredito {
  clientes: number
  cuentas: number
  abonos: number
  turnosCerrados: number
  hallazgos: HallazgoCredito[]
  errores: number
  avisos: number
}

const c = (n: number) => Math.round(n * 100)
const s = (cent: number) => cent / 100
const soles = (n: number) => `S/ ${n.toFixed(2)}`

export function auditarDatosCredito(d: DatosCredito): InformeCredito {
  const hallazgos: HallazgoCredito[] = []
  const hay = (
    codigo: CodigoHallazgoCredito, entidad: HallazgoCredito['entidad'], id: string, nombre: string, detalle: string,
    importes?: { esperado: number; encontrado: number },
  ) => hallazgos.push({ codigo, gravedad: GRAVEDAD[codigo], entidad, id, nombre, detalle, ...importes })

  const abonoPorId = new Map(d.abonos.map((a) => [a.id, a]))
  const cuentaPorId = new Map(d.cuentas.map((x) => [x.id, x]))
  const ventaPorId = new Map(d.ventas.map((v) => [v.id, v]))
  const cuentaDeVenta = new Map(d.cuentas.map((x) => [x.saleId, x]))

  // 1) La deuda del cliente es la suma de los saldos de sus cuentas ABIERTAS.
  for (const cl of d.clientes) {
    const suma = d.cuentas.filter((x) => x.customerId === cl.id && x.status === 'ABIERTA').reduce((a, x) => a + c(x.amount) - c(x.paidAmount), 0)
    if (c(cl.creditBalance) !== suma) {
      hay('DEUDA_CLIENTE', 'cliente', cl.id, cl.name, `La deuda guardada (${soles(cl.creditBalance)}) no es la suma de los saldos de sus cuentas abiertas (${soles(s(suma))}).`,
        { esperado: s(suma), encontrado: cl.creditBalance })
    }
  }

  // 2) Lo abonado de una cuenta es la suma de sus repartos de abonos NO anulados.
  const repartosVivos = new Map<string, number>()
  for (const r of d.repartos) {
    if (abonoPorId.get(r.paymentId)?.anulado) continue
    repartosVivos.set(r.receivableId, (repartosVivos.get(r.receivableId) ?? 0) + c(r.amount))
  }
  for (const x of d.cuentas) {
    const suma = repartosVivos.get(x.id) ?? 0
    if (c(x.paidAmount) !== suma) {
      const v = ventaPorId.get(x.saleId)
      hay('ABONADO_CUENTA', 'cuenta', x.id, v?.number ?? x.saleId, `Lo abonado de la cuenta (${soles(x.paidAmount)}) no es la suma de sus repartos vigentes (${soles(s(suma))}).`,
        { esperado: s(suma), encontrado: x.paidAmount })
    }
  }

  // 3) Un abono se reparte por completo: Σ repartos = monto (también los anulados: se conservan).
  const repartidoPorAbono = new Map<string, number>()
  for (const r of d.repartos) repartidoPorAbono.set(r.paymentId, (repartidoPorAbono.get(r.paymentId) ?? 0) + c(r.amount))
  for (const a of d.abonos) {
    const rep = repartidoPorAbono.get(a.id) ?? 0
    if (c(a.amount) !== rep) {
      hay('REPARTO_ABONO', 'abono', a.id, a.id, `El abono es de ${soles(a.amount)} pero sus repartos suman ${soles(s(rep))}.`, { esperado: a.amount, encontrado: s(rep) })
    }
  }

  // 4) Un abono solo paga cuentas de su propio cliente (las llaves foráneas compuestas son por negocio, no por cliente).
  for (const r of d.repartos) {
    const a = abonoPorId.get(r.paymentId), x = cuentaPorId.get(r.receivableId)
    if (a && x && a.customerId !== x.customerId) {
      hay('REPARTO_CLIENTE', 'abono', a.id, a.id, `Un reparto de ${soles(r.amount)} cae en una cuenta de OTRO cliente.`)
    }
  }

  // 5) Fiado ↔ cuenta: toda venta COMPLETADA con línea CREDITO tiene su cuenta, por ese monto y de ese cliente; y viceversa.
  for (const v of d.ventas) {
    const x = cuentaDeVenta.get(v.id)
    if (v.status === 'COMPLETADA' && v.fiado > 0 && !x) {
      hay('VENTA_FIADA_SIN_CUENTA', 'venta', v.id, v.number, `La venta fió ${soles(v.fiado)} pero no tiene cuenta por cobrar.`, { esperado: v.fiado, encontrado: 0 })
    }
    if (x) {
      if (v.fiado === 0) hay('CUENTA_SIN_FIADO_EN_VENTA', 'cuenta', x.id, v.number, 'Hay una cuenta por cobrar pero la venta no tiene ninguna línea a crédito.')
      else if (c(x.amount) !== c(v.fiado)) {
        hay('MONTO_CUENTA_VENTA', 'cuenta', x.id, v.number, `La cuenta es de ${soles(x.amount)} y la venta fió ${soles(v.fiado)}.`, { esperado: v.fiado, encontrado: x.amount })
      }
      if (v.customerId !== x.customerId) hay('CLIENTE_CUENTA_VENTA', 'cuenta', x.id, v.number, 'La cuenta es de un cliente distinto al de la venta.')
      if ((v.status === 'ANULADA' || v.status === 'DEVUELTA') && x.status === 'ABIERTA') {
        hay('VENTA_ANULADA_CUENTA_VIVA', 'cuenta', x.id, v.number, `La venta está ${v.status} pero su cuenta sigue abierta con saldo ${soles(s(c(x.amount) - c(x.paidAmount)))}.`)
      }
    }
  }
  for (const x of d.cuentas) {
    if (!ventaPorId.has(x.saleId)) hay('CUENTA_SIN_FIADO_EN_VENTA', 'cuenta', x.id, x.saleId, 'La cuenta apunta a una venta que no existe.')
    if (x.enRevision && x.status !== 'ANULADA') {
      hay('REVISION_PENDIENTE', 'cuenta', x.id, ventaPorId.get(x.saleId)?.number ?? x.saleId, 'Una nota de crédito marcó esta cuenta y el dueño todavía no la resolvió (castigar o descartar).')
    }
  }

  // 6) Un turno CERRADO es inmutable: lo congelado de abonos = lo enlazado a él. El fiado del turno se cuenta por lo RECIBIDO: una venta que
  //    luego se anula o se devuelve (ANULADA/DEVUELTA) sigue contando en el turno donde se hizo; su devolución sale en el turno que esté abierto
  //    entonces (F6.1). Solo una venta que llegó tras el cierre puede hacerlo diferir: por eso es AVISO.
  for (const t of d.turnosCerrados) {
    const propios = d.abonos.filter((a) => a.cashSessionId === t.id && !a.anulado)
    const ef = propios.filter((a) => a.method === 'EFECTIVO').reduce((a, p) => a + c(p.amount), 0)
    const ot = propios.filter((a) => a.method !== 'EFECTIVO').reduce((a, p) => a + c(p.amount), 0)
    if (c(t.cashReceiptsTotal) !== ef || c(t.otherReceiptsTotal) !== ot) {
      hay('CIERRE_ABONOS', 'turno', t.id, t.id,
        `Congelado: abonos en efectivo ${soles(t.cashReceiptsTotal)} y por otros medios ${soles(t.otherReceiptsTotal)}; enlazados al turno: ${soles(s(ef))} y ${soles(s(ot))}.`,
        { esperado: s(ef) + s(ot), encontrado: t.cashReceiptsTotal + t.otherReceiptsTotal })
    }
    const fiado = d.ventas.filter((v) => v.cashSessionId === t.id && (v.status === 'COMPLETADA' || v.status === 'ANULADA' || v.status === 'DEVUELTA')).reduce((a, v) => a + c(v.fiado), 0)
    if (c(t.creditSalesTotal) !== fiado) {
      hay('CIERRE_FIADO', 'turno', t.id, t.id, `El fiado congelado del cierre (${soles(t.creditSalesTotal)}) no coincide con las ventas fiadas del turno (las devueltas siguen contando) (${soles(s(fiado))}).`,
        { esperado: s(fiado), encontrado: t.creditSalesTotal })
    }
  }

  const errores = hallazgos.filter((h) => h.gravedad === 'ERROR').length
  return {
    clientes: d.clientes.length, cuentas: d.cuentas.length, abonos: d.abonos.length, turnosCerrados: d.turnosCerrados.length,
    hallazgos, errores, avisos: hallazgos.length - errores,
  }
}

const num = (v: unknown): number => Number(v ?? 0)

/** Lee TODO el crédito del negocio del cliente Prisma recibido (aislado por negocio) y lo audita. No escribe. */
export async function auditarCoherenciaCredito(db: TenantPrismaClient): Promise<InformeCredito> {
  const [clientes, cuentas, abonos, repartos, ventas, turnos] = await Promise.all([
    db.customer.findMany({ select: { id: true, name: true, creditBalance: true } }),
    db.receivable.findMany({ select: { id: true, customerId: true, saleId: true, amount: true, paidAmount: true, status: true, reviewRequestedAt: true } }),
    db.customerPayment.findMany({ select: { id: true, customerId: true, amount: true, method: true, voidedAt: true, cashSessionId: true } }),
    db.paymentAllocation.findMany({ select: { customerPaymentId: true, receivableId: true, amount: true } }),
    db.sale.findMany({
      where: { OR: [{ payments: { some: { method: 'CREDITO' } } }, { receivable: { isNot: null } }] },
      select: { id: true, number: true, status: true, customerId: true, cashSessionId: true, payments: { where: { method: 'CREDITO' }, select: { amount: true } } },
    }),
    db.cashSession.findMany({ where: { status: 'CERRADA' }, select: { id: true, cashReceiptsTotal: true, otherReceiptsTotal: true, creditSalesTotal: true } }),
  ])
  return auditarDatosCredito({
    clientes: clientes.map((x) => ({ id: x.id, name: x.name, creditBalance: num(x.creditBalance) })),
    cuentas: cuentas.map((x) => ({
      id: x.id, customerId: x.customerId, saleId: x.saleId, amount: num(x.amount), paidAmount: num(x.paidAmount),
      status: x.status, enRevision: x.reviewRequestedAt !== null,
    })),
    abonos: abonos.map((a) => ({ id: a.id, customerId: a.customerId, amount: num(a.amount), method: a.method, anulado: a.voidedAt !== null, cashSessionId: a.cashSessionId })),
    repartos: repartos.map((r) => ({ paymentId: r.customerPaymentId, receivableId: r.receivableId, amount: num(r.amount) })),
    ventas: ventas.map((v) => ({
      id: v.id, number: v.number, status: v.status, customerId: v.customerId, cashSessionId: v.cashSessionId,
      fiado: v.payments.reduce((a, p) => a + c(num(p.amount)), 0) / 100,
    })),
    turnosCerrados: turnos.map((t) => ({
      id: t.id, cashReceiptsTotal: num(t.cashReceiptsTotal), otherReceiptsTotal: num(t.otherReceiptsTotal), creditSalesTotal: num(t.creditSalesTotal),
    })),
  })
}

export function formatearInformeCredito(slug: string, i: InformeCredito, detalle = false): string {
  const l = [`\n▌ ${slug} — ${i.clientes} cliente(s), ${i.cuentas} cuenta(s), ${i.abonos} abono(s), ${i.turnosCerrados} turno(s) cerrado(s): ${i.errores} error(es), ${i.avisos} aviso(s)`]
  const por = new Map<CodigoHallazgoCredito, HallazgoCredito[]>()
  for (const h of i.hallazgos) por.set(h.codigo, [...(por.get(h.codigo) ?? []), h])
  for (const [codigo, hs] of [...por].sort((a, b) => (GRAVEDAD[a[0]] === 'ERROR' ? 0 : 1) - (GRAVEDAD[b[0]] === 'ERROR' ? 0 : 1))) {
    l.push(`  ${GRAVEDAD[codigo] === 'ERROR' ? '✗' : '!'} ${codigo} (${GRAVEDAD[codigo]}): ${hs.length}`)
    for (const h of detalle ? hs : hs.slice(0, 3)) l.push(`      · ${h.entidad} ${h.nombre} [${h.id}] — ${h.detalle}`)
    if (!detalle && hs.length > 3) l.push(`      · … y ${hs.length - 3} más (usa --detalle)`)
  }
  return l.join('\n')
}
