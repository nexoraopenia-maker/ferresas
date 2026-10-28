import {
  aDiezmilesimas, repartirDeudaYDinero, repartirEnProporcion, resolverLineas,
  type EstadoCuenta, type LineaResuelta, type LineaVendida, type MedioRestante, type ReparteDeudaDinero,
} from '@/features/devoluciones/parcial'

/**
 * Lo que la pantalla de «Devolver productos» calcula EN VIVO mientras se escribe: la MISMA función pura que usará el servidor (`resolverLineas`,
 * `repartirDeudaYDinero`), así que el importe, el reparto entre deuda y dinero y la sugerencia de reembolso que se ven son los que se aplicarán.
 * Sin base, sin React: se prueba aparte.
 */

export interface LineaPantalla {
  saleItemId: string
  nombre: string
  controlaStock: boolean
  calculo: { totalCent: number; vendidaM: number; tasa: number; yaDevueltaM: number; yaDevueltoImporteCent: number }
}
export interface PedidoPantalla { saleItemId: string; /** Lo escrito en la casilla ('' = nada). Unidades base. */ cantidad: string; destino: 'STOCK' | 'MERMA' }

export interface SugerenciaReembolso { method: string; cent: number }
export type CalculoParcial =
  | { estado: 'VACIO' }
  | { estado: 'ERROR'; mensaje: string }
  | {
    estado: 'OK'
    lineas: LineaResuelta[]
    totalCent: number
    completaVenta: boolean
    reparto: Extract<ReparteDeudaDinero, { ok: true }>
    /** El dinero vuelve en proporción a lo que cada medio aún tiene sin devolver. */
    sugerencia: SugerenciaReembolso[]
    mermas: number
  }
  | { estado: 'BLOQUEADO'; code: 'CREDIT_HAS_PAYMENTS' | 'INVALID_DOCUMENT'; mensaje: string; topeCent: number }

export function calcularDevolucionParcial(
  lineas: readonly LineaPantalla[], pedidos: readonly PedidoPantalla[], cuenta: EstadoCuenta | null, contadoPorMedio: readonly MedioRestante[],
): CalculoParcial {
  const pedidas = pedidos.filter((p) => p.cantidad.trim() !== '' && Number(p.cantidad) !== 0)
  if (pedidas.length === 0) return { estado: 'VACIO' }
  const vendidas: LineaVendida[] = lineas.map((l) => ({ id: l.saleItemId, nombre: l.nombre, trackStock: l.controlaStock, ...l.calculo }))
  const r = resolverLineas(vendidas, pedidas.map((p) => ({ saleItemId: p.saleItemId, cantidad: Number(p.cantidad.replace(',', '.')), destino: p.destino })))
  if (!r.ok) return { estado: 'ERROR', mensaje: r.mensaje }
  const contadoTotal = contadoPorMedio.reduce((a, m) => a + m.cent, 0)
  const reparto = repartirDeudaYDinero(r.totalCent, cuenta, contadoTotal)
  if (!reparto.ok) return { estado: 'BLOQUEADO', code: reparto.code, mensaje: reparto.mensaje, topeCent: reparto.topeCent }
  return {
    estado: 'OK', lineas: r.lineas, totalCent: r.totalCent, completaVenta: r.completaVenta, reparto,
    sugerencia: repartirEnProporcion(reparto.dineroCent, contadoPorMedio).map((x) => ({ method: x.method, cent: x.cent })),
    mermas: r.lineas.filter((l) => l.destino === 'MERMA').length,
  }
}

/** ¿Es un número de cantidad que la casilla admite escribir? (hasta 4 decimales, sin signo) */
export const cantidadValida = (txt: string): boolean => {
  if (txt.trim() === '') return true
  try { return aDiezmilesimas(Number(txt.replace(',', '.'))) >= 0 } catch { return false }
}

/** «Devolver lo que falta»: la cantidad pendiente de cada línea (en texto, unidades base). */
export const pendienteComoTexto = (l: { calculo: { vendidaM: number; yaDevueltaM: number } }): string => String((l.calculo.vendidaM - l.calculo.yaDevueltaM) / 10_000)

/** A cuánto equivale una cantidad en unidades base si se vendió por presentación (caja ×12): «0.25 × Caja x 12». */
export function equivalenciaPresentacion(cantidadBase: number, p: { nombre: string; factor: number } | null): string | null {
  if (!p || !(p.factor > 0) || !(cantidadBase > 0)) return null
  const e = Math.round((cantidadBase / p.factor) * 10_000) / 10_000
  return `${e} × ${p.nombre}`
}

export interface EstadoEnvio {
  puedeOperar: boolean
  /** El cálculo en vivo está en `OK` (cantidades válidas y sin bloqueo por abonos). */
  calculoOk: boolean
  sinCaja: boolean
  faltaMotivoSinSalida: boolean
  motivo: string
  confirmo: boolean
  pendiente: boolean
}

/** ¿Se puede enviar la devolución? Solo si TODO está en orden: cuenta con escritura, cálculo válido, caja si hace falta, motivos, confirmación y sin envío en curso. */
export function sePuedeEnviar(e: EstadoEnvio): boolean {
  return e.puedeOperar && e.calculoOk && !e.sinCaja && !e.faltaMotivoSinSalida && e.motivo.trim().length >= 3 && e.confirmo && !e.pendiente
}
