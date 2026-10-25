import type { TenantPrismaClient } from '@/lib/tenant-prisma'

/**
 * Auditoría de SOLO LECTURA del vuelto mal guardado antes de la Fase 3 (Paso 1).
 *
 * Antes, el vuelto solo se registraba si el PRIMER pago era efectivo. En una venta mixta con el efectivo en segundo lugar
 * (p. ej. `[Yape 50, efectivo 60]` sobre 100) el vuelto de 10 no se guardó, y el cierre de caja esperaba 10 de más en el cajón:
 * el cajero contaba 10 menos y el sistema lo registró como un faltante que no existió.
 *
 * Este módulo NO escribe nada ni corrige nada: solo mide el impacto para que una persona decida si hace falta un ajuste contable.
 */

export interface PagoHistorico { method: string; amount: number; change: number }
export interface VentaHistorica { id: string; number: string; fecha: Date; total: number; cashSessionId: string | null; pagos: PagoHistorico[] }

/**
 *  · PERDIDO: faltó registrar vuelto que sí salió del cajón (hay efectivo suficiente). Es el bug.
 *  · EXCESO: se registró más vuelto del que correspondía.
 *  · SIN_EFECTIVO: se pagó de más con medios que no dan vuelto (Yape/tarjeta…). No se puede saber cuánto salió del cajón: revisar a mano.
 */
export type CategoriaVuelto = 'PERDIDO' | 'EXCESO' | 'SIN_EFECTIVO'

export interface HallazgoVuelto {
  saleId: string; number: string; fecha: Date; cashSessionId: string | null
  total: number; pagado: number
  vueltoRegistrado: number; vueltoCorrecto: number
  /** vueltoCorrecto − vueltoRegistrado. Positivo: faltó registrar vuelto. */
  faltante: number
  categoria: CategoriaVuelto
}

const c = (n: number) => Math.round(n * 100)
const d = (n: number) => n / 100

/** `null` si el vuelto de la venta está bien guardado. En céntimos enteros: sin ruido de flotantes. */
export function evaluarVenta(v: VentaHistorica): HallazgoVuelto | null {
  const T = c(v.total)
  const S = v.pagos.reduce((s, p) => s + c(p.amount), 0)
  const R = v.pagos.reduce((s, p) => s + c(p.change), 0)
  const C = v.pagos.reduce((s, p) => (p.method === 'EFECTIVO' ? s + c(p.amount) : s), 0)
  const E = Math.max(0, S - T)
  if (R === E) return null
  const categoria: CategoriaVuelto = E > C ? 'SIN_EFECTIVO' : R < E ? 'PERDIDO' : 'EXCESO'
  return {
    saleId: v.id, number: v.number, fecha: v.fecha, cashSessionId: v.cashSessionId,
    total: v.total, pagado: d(S), vueltoRegistrado: d(R), vueltoCorrecto: d(E), faltante: d(E - R), categoria,
  }
}

export interface ResumenTurno {
  cashSessionId: string; sucursal: string; estado: string; abierto: Date; cerrado: Date | null
  esperadoRegistrado: number | null; diferenciaRegistrada: number | null
  /** Σ faltante de las ventas PERDIDO/EXCESO del turno (las SIN_EFECTIVO no entran: no se sabe qué salió del cajón). */
  faltante: number
  /** Para turnos CERRADOS: diferencia registrada + faltante. Es lo que habría dado con el vuelto bien guardado. */
  diferenciaCorregida: number | null
  ventas: number
}

export interface InformeVueltos {
  ventasRevisadas: number
  hallazgos: HallazgoVuelto[]
  turnos: ResumenTurno[]
  sinTurno: number
}

const LOTE = 500
const num = (x: { toString(): string } | null | undefined) => (x == null ? null : Number(x.toString()))

export async function auditarVueltos(db: TenantPrismaClient, opciones: { desde?: Date } = {}): Promise<InformeVueltos> {
  const hallazgos: HallazgoVuelto[] = []
  let revisadas = 0
  let cursor: string | undefined
  for (;;) {
    const lote = await db.sale.findMany({
      where: { status: 'COMPLETADA', payments: { some: {} }, ...(opciones.desde ? { createdAt: { gte: opciones.desde } } : {}) },
      select: { id: true, number: true, total: true, cashSessionId: true, createdAt: true, payments: { select: { method: true, amount: true, change: true } } },
      orderBy: { id: 'asc' }, take: LOTE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    })
    if (lote.length === 0) break
    for (const v of lote) {
      revisadas++
      const h = evaluarVenta({
        id: v.id, number: v.number, fecha: v.createdAt, total: Number(v.total), cashSessionId: v.cashSessionId,
        pagos: v.payments.map((p) => ({ method: p.method, amount: Number(p.amount), change: Number(p.change) })),
      })
      if (h) hallazgos.push(h)
    }
    cursor = lote[lote.length - 1]!.id
    if (lote.length < LOTE) break
  }

  const ids = [...new Set(hallazgos.map((h) => h.cashSessionId).filter((x): x is string => !!x))]
  const sesiones = ids.length
    ? await db.cashSession.findMany({ where: { id: { in: ids } }, select: { id: true, branchId: true, status: true, openedAt: true, closedAt: true, expectedAmount: true, difference: true } })
    : []
  const sucursales = new Map((await db.branch.findMany({ select: { id: true, name: true } })).map((b) => [b.id, b.name]))
  const turnos: ResumenTurno[] = sesiones
    .map((s) => {
      const propios = hallazgos.filter((h) => h.cashSessionId === s.id)
      const faltante = d(propios.filter((h) => h.categoria !== 'SIN_EFECTIVO').reduce((x, h) => x + c(h.faltante), 0))
      const dif = num(s.difference)
      return {
        cashSessionId: s.id, sucursal: sucursales.get(s.branchId) ?? s.branchId, estado: s.status, abierto: s.openedAt, cerrado: s.closedAt,
        esperadoRegistrado: num(s.expectedAmount), diferenciaRegistrada: dif, faltante,
        diferenciaCorregida: s.status === 'CERRADA' && dif != null ? d(c(dif) + c(faltante)) : null,
        ventas: propios.length,
      }
    })
    .sort((a, b) => a.abierto.getTime() - b.abierto.getTime())

  return { ventasRevisadas: revisadas, hallazgos, turnos, sinTurno: hallazgos.filter((h) => !h.cashSessionId).length }
}

const money = (n: number | null) => (n == null ? '—' : `S/ ${n.toFixed(2)}`)
const dia = (f: Date | null) => (f ? f.toISOString().slice(0, 10) : '—')

export function formatearInformeVueltos(slug: string, i: InformeVueltos, detalle: boolean): string {
  const por = (k: CategoriaVuelto) => i.hallazgos.filter((h) => h.categoria === k)
  const L: string[] = [`\n▸ ${slug}: ${i.ventasRevisadas} ventas revisadas, ${i.hallazgos.length} con el vuelto mal guardado`]
  if (i.hallazgos.length === 0) return L.join('\n')
  L.push(`    · vuelto PERDIDO (salió del cajón y no se registró): ${por('PERDIDO').length} ventas, ${money(por('PERDIDO').reduce((s, h) => s + h.faltante, 0))}`)
  if (por('EXCESO').length) L.push(`    · vuelto de MÁS (se registró más del debido): ${por('EXCESO').length} ventas`)
  if (por('SIN_EFECTIVO').length) L.push(`    · sobrepago SIN efectivo (Yape/tarjeta…; revisar a mano): ${por('SIN_EFECTIVO').length} ventas, ${money(por('SIN_EFECTIVO').reduce((s, h) => s + h.faltante, 0))}`)
  if (i.sinTurno) L.push(`    · ${i.sinTurno} de ellas sin turno de caja: no afectan a ningún arqueo`)
  if (i.turnos.length) {
    L.push('    Turnos afectados (diferencia corregida = diferencia registrada + vuelto no registrado):')
    for (const t of i.turnos) {
      L.push(`      ${t.cashSessionId.slice(-8)} · ${t.sucursal} · ${dia(t.abierto)} · ${t.estado} · ${t.ventas} venta(s) · vuelto no registrado ${money(t.faltante)}` +
        (t.estado === 'CERRADA' ? ` · diferencia registrada ${money(t.diferenciaRegistrada)} → corregida ${money(t.diferenciaCorregida)}` : ' · EN CURSO: el esperado en pantalla seguirá 10 de más hasta cerrarlo; cuéntalo al cerrar'))
    }
  }
  if (detalle) {
    L.push('    Detalle por venta:')
    for (const h of i.hallazgos) L.push(`      ${h.number} · ${dia(h.fecha)} · ${h.categoria} · total ${money(h.total)} · pagado ${money(h.pagado)} · vuelto registrado ${money(h.vueltoRegistrado)} / correcto ${money(h.vueltoCorrecto)}`)
  }
  return L.join('\n')
}
