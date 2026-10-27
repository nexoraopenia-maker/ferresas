import { claveDeGrupo, etiquetaDeGrupo, type Granularidad } from './periodo'

/**
 * Los reportes de ventas, como funciones PURAS sobre filas ya leídas. Sin base, sin reloj, sin permisos: el servicio lee y autoriza; aquí
 * solo se suma. Todo en céntimos enteros (nunca se suman decimales de coma flotante) y se devuelve en soles.
 *
 * ─── DEFINICIONES (las mismas en pantalla, en CSV y en las pruebas) ─────────────────────────────────────────────────────────────
 *  · VENTA: una venta COMPLETADA, fechada por el día (del negocio) en que se completó. Las anuladas y devueltas no cuentan.
 *  · A CRÉDITO: cuenta como venta el día de la operación. El fiado es un «medio» más (la venta se pagó con deuda); el abono posterior
 *    NO es venta: es un cobro (ver `cobrosPorMedio`).
 *  · MONTO DE UN MEDIO: lo cobrado menos el vuelto. En efectivo el cliente entrega más y se le devuelve la diferencia: la venta se
 *    pagó con `entregado − vuelto`, y por eso los medios de una venta suman su total.
 *  · VENDEDOR: quien armó el pedido o la cotización de la que nació la venta; si la venta no viene de uno, quien la registró. También
 *    se puede atribuir a QUIEN COBRÓ en caja.
 */

const c = (n: number) => Math.round(n * 100)
const s = (cent: number) => cent / 100
/** Porcentaje con dos decimales, sobre céntimos. 0 si no hay base. */
const pct = (parteC: number, totalC: number) => (totalC > 0 ? Math.round((parteC * 10_000) / totalC) / 100 : 0)
/** Promedio redondeado al céntimo (mitad hacia arriba). */
const promedio = (totalC: number, n: number) => (n > 0 ? s(Math.round(totalC / n)) : 0)

export const ETIQUETA_METODO: Record<string, string> = {
  EFECTIVO: 'Efectivo', TARJETA_DEBITO: 'Tarjeta de débito', TARJETA_CREDITO: 'Tarjeta de crédito', TRANSFERENCIA: 'Transferencia',
  YAPE: 'Yape', PLIN: 'Plin', CREDITO: 'Fiado (a crédito)', OTRO: 'Otro',
}
export const etiquetaMetodo = (m: string) => ETIQUETA_METODO[m] ?? m

export interface PagoFila { metodo: string; monto: number; vuelto: number }
export interface VentaFila {
  id: string
  numero: string
  completedAt: Date
  total: number
  igv: number
  descuentos: number
  /** Quien armó el pedido/cotización; si no hay, quien registró la venta. */
  vendedorId: string
  /** Quien registró (cobró) la venta. */
  cobroId: string
  pagos: PagoFila[]
}

// ─── Ventas por periodo ─────────────────────────────────────────────────────────────────────────────────────────────

export interface FilaPeriodo { clave: string; etiqueta: string; ventas: number; total: number; igv: number; descuentos: number; ticketPromedio: number }
export interface VentasPorPeriodo { granularidad: Granularidad; filas: FilaPeriodo[]; totales: Omit<FilaPeriodo, 'clave' | 'etiqueta'> }

export function ventasPorPeriodo(
  ventas: readonly VentaFila[], g: Granularidad, zona: string, grupos: readonly { clave: string; etiqueta: string }[],
): VentasPorPeriodo {
  const acc = new Map<string, { n: number; total: number; igv: number; desc: number }>(grupos.map((x) => [x.clave, { n: 0, total: 0, igv: 0, desc: 0 }]))
  for (const v of ventas) {
    const k = claveDeGrupo(v.completedAt, zona, g)
    // Una venta fuera de los grupos del periodo no debería llegar (el servicio filtra por rango); si llega, se cuenta en su grupo en vez de perderse.
    const a = acc.get(k) ?? { n: 0, total: 0, igv: 0, desc: 0 }
    a.n++; a.total += c(v.total); a.igv += c(v.igv); a.desc += c(v.descuentos)
    acc.set(k, a)
  }
  const claves = [...grupos.map((x) => x.clave), ...[...acc.keys()].filter((k) => !grupos.some((x) => x.clave === k)).sort()]
  const filas = claves.map((clave): FilaPeriodo => {
    const a = acc.get(clave)!
    return { clave, etiqueta: grupos.find((x) => x.clave === clave)?.etiqueta ?? etiquetaDeGrupo(clave, g), ventas: a.n, total: s(a.total), igv: s(a.igv), descuentos: s(a.desc), ticketPromedio: promedio(a.total, a.n) }
  })
  const T = [...acc.values()].reduce((x, a) => ({ n: x.n + a.n, total: x.total + a.total, igv: x.igv + a.igv, desc: x.desc + a.desc }), { n: 0, total: 0, igv: 0, desc: 0 })
  return { granularidad: g, filas, totales: { ventas: T.n, total: s(T.total), igv: s(T.igv), descuentos: s(T.desc), ticketPromedio: promedio(T.total, T.n) } }
}

// ─── Por vendedor ───────────────────────────────────────────────────────────────────────────────────────────────────

export type Atribucion = 'VENDEDOR' | 'COBRO'
export interface FilaVendedor { userId: string; nombre: string; ventas: number; total: number; ticketPromedio: number; participacion: number }
export interface VentasPorVendedor { atribucion: Atribucion; filas: FilaVendedor[]; totales: { ventas: number; total: number; ticketPromedio: number } }

export function ventasPorVendedor(ventas: readonly VentaFila[], atribucion: Atribucion, nombres: ReadonlyMap<string, string>): VentasPorVendedor {
  const acc = new Map<string, { n: number; total: number }>()
  let totalC = 0
  for (const v of ventas) {
    const id = atribucion === 'VENDEDOR' ? v.vendedorId : v.cobroId
    const a = acc.get(id) ?? { n: 0, total: 0 }
    a.n++; a.total += c(v.total); totalC += c(v.total)
    acc.set(id, a)
  }
  const orden = new Intl.Collator('es', { sensitivity: 'base', numeric: true })
  const filas = [...acc].map(([userId, a]): FilaVendedor => ({
    userId, nombre: nombres.get(userId) ?? '(usuario eliminado)', ventas: a.n, total: s(a.total), ticketPromedio: promedio(a.total, a.n), participacion: pct(a.total, totalC),
  })).sort((x, y) => y.total - x.total || orden.compare(x.nombre, y.nombre) || (x.userId < y.userId ? -1 : 1))
  const n = ventas.length
  return { atribucion, filas, totales: { ventas: n, total: s(totalC), ticketPromedio: promedio(totalC, n) } }
}

// ─── Por medio de pago (cómo se pagaron las ventas) ─────────────────────────────────────────────────────────────────

export interface FilaMedio { metodo: string; etiqueta: string; ventas: number; monto: number; participacion: number }
export interface VentasPorMedio {
  filas: FilaMedio[]
  totalVentas: number
  totalMedios: number
  /** Ventas cuyos pagos NO suman su total (datos históricos, p. ej. vueltos de antes de que existieran): se avisan, no se esconden. */
  descuadradas: { ventas: number; diferencia: number }
}

/** Lo realmente pagado con un medio en una línea de pago: lo entregado menos el vuelto. EN CÉNTIMOS. */
export const netoDePagoCentimos = (p: PagoFila): number => c(p.monto) - c(p.vuelto)

export function ventasPorMedio(ventas: readonly VentaFila[]): VentasPorMedio {
  const acc = new Map<string, { monto: number; ids: Set<string> }>()
  let totalVentasC = 0, totalMediosC = 0, dif = 0, nDesc = 0
  for (const v of ventas) {
    totalVentasC += c(v.total)
    let pagadoC = 0
    for (const p of v.pagos) {
      const neto = netoDePagoCentimos(p)
      pagadoC += neto
      const a = acc.get(p.metodo) ?? { monto: 0, ids: new Set<string>() }
      a.monto += neto; a.ids.add(v.id)
      acc.set(p.metodo, a)
    }
    totalMediosC += pagadoC
    if (pagadoC !== c(v.total)) { nDesc++; dif += c(v.total) - pagadoC }
  }
  const filas = [...acc].map(([metodo, a]): FilaMedio => ({ metodo, etiqueta: etiquetaMetodo(metodo), ventas: a.ids.size, monto: s(a.monto), participacion: pct(a.monto, totalMediosC) }))
    .sort((x, y) => y.monto - x.monto || (x.metodo < y.metodo ? -1 : 1))
  return { filas, totalVentas: s(totalVentasC), totalMedios: s(totalMediosC), descuadradas: { ventas: nDesc, diferencia: s(dif) } }
}

// ─── Cobros por medio de pago (la plata que ENTRÓ: ventas de contado + abonos de deuda) ────────────────────────────────

export interface FilaCobro { metodo: string; etiqueta: string; contado: number; abonos: number; total: number; operacionesContado: number; operacionesAbono: number; participacion: number }
export interface CobrosPorMedio {
  filas: FilaCobro[]
  totales: { contado: number; abonos: number; total: number; operacionesContado: number; operacionesAbono: number }
}

/**
 * Cobros del periodo: lo pagado en el acto por las ventas (sin la parte fiada, y neto de vuelto) más los abonos de deuda no anulados.
 * Una venta a crédito NO aparece aquí el día que se vende —no entró dinero—; entra cuando el cliente abona.
 */
export function cobrosPorMedio(pagosDeVentas: readonly PagoFila[], abonos: readonly { metodo: string; monto: number }[]): CobrosPorMedio {
  const acc = new Map<string, { co: number; ab: number; nCo: number; nAb: number }>()
  const tomar = (m: string) => acc.get(m) ?? { co: 0, ab: 0, nCo: 0, nAb: 0 }
  for (const p of pagosDeVentas) {
    if (p.metodo === 'CREDITO') continue
    const a = tomar(p.metodo); a.co += netoDePagoCentimos(p); a.nCo++; acc.set(p.metodo, a)
  }
  for (const x of abonos) {
    if (x.metodo === 'CREDITO') continue
    const a = tomar(x.metodo); a.ab += c(x.monto); a.nAb++; acc.set(x.metodo, a)
  }
  const totalC = [...acc.values()].reduce((t, a) => t + a.co + a.ab, 0)
  const filas = [...acc].map(([metodo, a]): FilaCobro => ({
    metodo, etiqueta: etiquetaMetodo(metodo), contado: s(a.co), abonos: s(a.ab), total: s(a.co + a.ab),
    operacionesContado: a.nCo, operacionesAbono: a.nAb, participacion: pct(a.co + a.ab, totalC),
  })).sort((x, y) => y.total - x.total || (x.metodo < y.metodo ? -1 : 1))
  const T = [...acc.values()].reduce((t, a) => ({ co: t.co + a.co, ab: t.ab + a.ab, nCo: t.nCo + a.nCo, nAb: t.nAb + a.nAb }), { co: 0, ab: 0, nCo: 0, nAb: 0 })
  return { filas, totales: { contado: s(T.co), abonos: s(T.ab), total: s(T.co + T.ab), operacionesContado: T.nCo, operacionesAbono: T.nAb } }
}
