/**
 * El desglose del cierre de un turno (F6.8a): agrupa lo que ocurrió en el turno por método de pago y por concepto. Función PURA, sin base de datos ni React; la foto resultante se congela
 * en `cash_sessions.closingBreakdown` al cerrar (F6.8b) para que una reimpresión salga idéntica. Nunca contiene costos, márgenes ni valor de inventario.
 *
 *  · Ventas por método, cada uno en su línea: efectivo, **Yape**, **Plin**, tarjeta de débito, tarjeta de crédito, transferencia, otro y fiado. Los vueltos se descuentan SOLO del efectivo.
 *  · Una venta cuenta por lo que se cobró en el turno aunque después se haya devuelto o anulado (como el cierre de siempre); lo devuelto sale aparte, en el turno donde se devuelve.
 *  · Todo en céntimos redondeados una vez por suma, nunca acumulando coma flotante.
 */
import { redondearCentimos as cent } from '@/lib/dinero'

export const METODOS_REPORTE = ['EFECTIVO', 'YAPE', 'PLIN', 'TARJETA_DEBITO', 'TARJETA_CREDITO', 'TRANSFERENCIA', 'OTRO', 'CREDITO'] as const
export type MetodoReporte = (typeof METODOS_REPORTE)[number]

export const ETIQUETA_METODO: Readonly<Record<MetodoReporte, string>> = {
  EFECTIVO: 'Efectivo', YAPE: 'Yape', PLIN: 'Plin', TARJETA_DEBITO: 'Tarjeta de débito', TARJETA_CREDITO: 'Tarjeta de crédito',
  TRANSFERENCIA: 'Transferencia', OTRO: 'Otro medio', CREDITO: 'Fiado (a crédito)',
}

/** Versión del formato congelado: si cambia, los lectores saben qué esperar. */
export const VERSION_DESGLOSE = 1

export interface LineaMetodo { operaciones: number; monto: number }

export interface EntradaDesglose {
  ventas: { numero: string; status: 'COMPLETADA' | 'ANULADA' | 'DEVUELTA'; total: number; discountTotal: number; bajoCosto: boolean }[]
  /** Los pagos de las ventas del turno (`change` es el vuelto de esa línea; solo el efectivo da vuelto). */
  pagos: { method: MetodoReporte; amount: number; change: number }[]
  /** Reembolsos de devoluciones hechas en el turno. `CAJA` sale del cajón; `EXTERNO` es por otro medio; `SIN_SALIDA` no mueve dinero. */
  devoluciones: { mode: 'CAJA' | 'EXTERNO' | 'SIN_SALIDA'; method: MetodoReporte | null; amount: number }[]
  abonos: { method: MetodoReporte; amount: number }[]
  pagosProveedor: { method: MetodoReporte; amount: number }[]
  movimientos: { kind: 'INGRESO' | 'EGRESO'; category: string; amount: number }[]
}

export interface DesgloseCierre {
  version: typeof VERSION_DESGLOSE
  ventasPorMetodo: Record<MetodoReporte, LineaMetodo>
  /** Lo cobrado que NO es fiado, sin vueltos: lo que de verdad entró (efectivo neto + billeteras + tarjetas + transferencias). */
  cobradoNeto: number
  vueltos: number
  ventas: {
    cantidad: number
    /** Lo vendido en el turno (incluye lo fiado y lo que luego se devolvió). */
    total: number
    descuentos: { total: number; ventasConDescuento: number }
    anuladas: { cantidad: number; monto: number }
    bajoCosto: { cantidad: number; ventas: string[] }
  }
  devoluciones: { porMetodo: Record<MetodoReporte, LineaMetodo>; delCajon: number; porOtroMedio: number; sinSalida: number }
  abonosPorMetodo: Record<MetodoReporte, LineaMetodo>
  pagosProveedorPorMetodo: Record<MetodoReporte, LineaMetodo>
  movimientos: { ingresos: Record<string, number>; egresos: Record<string, number>; totalIngresos: number; totalEgresos: number }
}

const vacio = (): Record<MetodoReporte, LineaMetodo> =>
  Object.fromEntries(METODOS_REPORTE.map((m) => [m, { operaciones: 0, monto: 0 }])) as Record<MetodoReporte, LineaMetodo>

function sumar(destino: Record<MetodoReporte, LineaMetodo>, metodo: MetodoReporte, monto: number) {
  const l = destino[metodo]
  l.operaciones += 1
  l.monto = cent(l.monto + monto)
}

export function construirDesglose(e: EntradaDesglose): DesgloseCierre {
  const ventasPorMetodo = vacio()
  let vueltos = 0
  for (const p of e.pagos) {
    // El vuelto sale de la línea de EFECTIVO que lo dio: la billetera o la tarjeta se cobran por el total exacto.
    const neto = p.method === 'EFECTIVO' ? cent(p.amount - p.change) : p.amount
    sumar(ventasPorMetodo, p.method, neto)
    if (p.method === 'EFECTIVO') vueltos = cent(vueltos + p.change)
  }
  const cobradoNeto = cent(METODOS_REPORTE.filter((m) => m !== 'CREDITO').reduce((s, m) => s + ventasPorMetodo[m].monto, 0))

  const anuladas = e.ventas.filter((v) => v.status !== 'COMPLETADA')
  const conDescuento = e.ventas.filter((v) => v.discountTotal > 0)
  const bajoCosto = e.ventas.filter((v) => v.bajoCosto).map((v) => v.numero).sort()

  const porMetodoDev = vacio()
  let delCajon = 0, porOtroMedio = 0, sinSalida = 0
  for (const d of e.devoluciones) {
    if (d.mode === 'SIN_SALIDA') { sinSalida = cent(sinSalida + d.amount); continue }
    sumar(porMetodoDev, d.method ?? 'EFECTIVO', d.amount)
    if (d.mode === 'CAJA') delCajon = cent(delCajon + d.amount)
    else porOtroMedio = cent(porOtroMedio + d.amount)
  }

  const abonosPorMetodo = vacio()
  for (const a of e.abonos) sumar(abonosPorMetodo, a.method, a.amount)
  const pagosProveedorPorMetodo = vacio()
  for (const p of e.pagosProveedor) sumar(pagosProveedorPorMetodo, p.method, p.amount)

  const ingresos: Record<string, number> = {}, egresos: Record<string, number> = {}
  let totalIngresos = 0, totalEgresos = 0
  for (const m of e.movimientos) {
    const destino = m.kind === 'INGRESO' ? ingresos : egresos
    destino[m.category] = cent((destino[m.category] ?? 0) + m.amount)
    if (m.kind === 'INGRESO') totalIngresos = cent(totalIngresos + m.amount)
    else totalEgresos = cent(totalEgresos + m.amount)
  }

  return {
    version: VERSION_DESGLOSE,
    ventasPorMetodo, cobradoNeto, vueltos,
    ventas: {
      cantidad: e.ventas.length,
      total: cent(e.ventas.reduce((s, v) => s + v.total, 0)),
      descuentos: { total: cent(e.ventas.reduce((s, v) => s + v.discountTotal, 0)), ventasConDescuento: conDescuento.length },
      anuladas: { cantidad: anuladas.length, monto: cent(anuladas.reduce((s, v) => s + v.total, 0)) },
      bajoCosto: { cantidad: bajoCosto.length, ventas: bajoCosto },
    },
    devoluciones: { porMetodo: porMetodoDev, delCajon, porOtroMedio, sinSalida },
    abonosPorMetodo, pagosProveedorPorMetodo,
    movimientos: { ingresos, egresos, totalIngresos, totalEgresos },
  }
}
