/**
 * Reglas de la anulación / devolución de una venta completa (F6.1), como funciones PURAS. Todo el dinero en céntimos enteros.
 * El servicio las aplica dentro de la transacción; aquí solo se decide QUÉ hay que hacer y qué se rechaza, para poder probarlo sin base.
 */
import { redondearCentimos } from '@/lib/dinero'

const c = (n: number) => Math.round(n * 100)
const s = (cent: number) => cent / 100

export type TipoDevolucion = 'ANULACION' | 'DEVOLUCION'
export type ModoReembolso = 'CAJA' | 'EXTERNO' | 'SIN_SALIDA'
export type MedioPago = 'EFECTIVO' | 'TARJETA_DEBITO' | 'TARJETA_CREDITO' | 'TRANSFERENCIA' | 'YAPE' | 'PLIN' | 'CREDITO' | 'OTRO'

export const ESTADO_FINAL: Record<TipoDevolucion, 'ANULADA' | 'DEVUELTA'> = { ANULACION: 'ANULADA', DEVOLUCION: 'DEVUELTA' }
/** Motivo de la nota de crédito total: 01 anulación de la operación · 06 devolución total. */
export const CODIGO_NOTA: Record<TipoDevolucion, '01' | '06'> = { ANULACION: '01', DEVOLUCION: '06' }
export const ETIQUETA_TIPO: Record<TipoDevolucion, string> = { ANULACION: 'Anulación', DEVOLUCION: 'Devolución' }

// ─── Lo que el cliente pagó de verdad ──────────────────────────────────────────────────────────────────────────────────────

export interface PagoDeVenta { method: string; amount: number; change: number }
export interface PagadoNeto {
  /** Lo pagado sin lo fiado y sin el vuelto: la suma de los reembolsos tiene que ser exactamente esto. */
  netoCent: number
  /** La parte fiada. */
  fiadoCent: number
  /** Neto por medio de pago (sin CREDITO). */
  porMedio: { method: MedioPago; cent: number }[]
}

export function pagadoNeto(pagos: readonly PagoDeVenta[]): PagadoNeto {
  const por = new Map<string, number>()
  let fiado = 0
  for (const p of pagos) {
    if (p.method === 'CREDITO') { fiado += c(p.amount); continue }
    por.set(p.method, (por.get(p.method) ?? 0) + c(p.amount) - c(p.change))
  }
  const porMedio = [...por].filter(([, v]) => v > 0).map(([method, cent]) => ({ method: method as MedioPago, cent })).sort((a, b) => (a.method < b.method ? -1 : 1))
  return { netoCent: porMedio.reduce((a, x) => a + x.cent, 0), fiadoCent: fiado, porMedio }
}

// ─── Reembolsos ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ReembolsoEntrada { mode: ModoReembolso; method?: MedioPago | null; amount: number; reference?: string | null }
export interface ReembolsoValido { mode: ModoReembolso; method: MedioPago | null; amount: number; reference: string | null }

/** Por defecto el dinero vuelve por donde entró: el efectivo sale del cajón y los demás medios, por fuera de él. */
export function reembolsosPorDefecto(p: PagadoNeto): ReembolsoValido[] {
  return p.porMedio.map((x) => ({ mode: x.method === 'EFECTIVO' ? 'CAJA' : 'EXTERNO', method: x.method, amount: s(x.cent), reference: null }))
}

export type ResultadoReembolsos = { ok: true; reembolsos: ReembolsoValido[] } | { ok: false; mensaje: string }

/**
 * Cada sol queda explicado: la suma de TODOS los reembolsos (incluidos los «sin salida de dinero») es exactamente lo pagado.
 *  · CAJA = efectivo desde el cajón (el método es siempre EFECTIVO).
 *  · EXTERNO = otro medio (ni efectivo ni crédito) sin tocar el cajón.
 *  · SIN_SALIDA = no se devuelve dinero: exige un motivo (en `reference`, 3 a 120 caracteres).
 * Si no se mandan reembolsos se usan los de por defecto. Una venta sin dinero pagado (todo fiado) no admite reembolsos.
 */
export function validarReembolsos(entrada: readonly ReembolsoEntrada[] | undefined, pagado: PagadoNeto): ResultadoReembolsos {
  if (pagado.netoCent === 0) {
    return entrada && entrada.length > 0
      ? { ok: false, mensaje: 'Esta venta no tiene dinero pagado (todo fue fiado): no hay nada que reembolsar.' }
      : { ok: true, reembolsos: [] }
  }
  if (!entrada || entrada.length === 0) return { ok: true, reembolsos: reembolsosPorDefecto(pagado) }
  const out: ReembolsoValido[] = []
  for (const r of entrada) {
    if (!Number.isFinite(r.amount) || c(r.amount) <= 0) return { ok: false, mensaje: 'Cada reembolso debe ser mayor que cero.' }
    if (Math.abs(r.amount * 100 - Math.round(r.amount * 100)) > 1e-6) return { ok: false, mensaje: 'Los importes llevan como máximo 2 decimales.' }
    const ref = r.reference?.trim() || null
    if (r.mode === 'CAJA') {
      if (r.method && r.method !== 'EFECTIVO') return { ok: false, mensaje: 'Lo que sale del cajón es siempre en efectivo.' }
      out.push({ mode: 'CAJA', method: 'EFECTIVO', amount: s(c(r.amount)), reference: ref })
    } else if (r.mode === 'EXTERNO') {
      if (!r.method || r.method === 'EFECTIVO' || r.method === 'CREDITO') return { ok: false, mensaje: 'Un reembolso por fuera del cajón necesita un medio (Yape, Plin, transferencia, tarjeta…), no efectivo.' }
      out.push({ mode: 'EXTERNO', method: r.method, amount: s(c(r.amount)), reference: ref })
    } else if (r.mode === 'SIN_SALIDA') {
      if (!ref || ref.length < 3) return { ok: false, mensaje: 'Si no se devuelve dinero, explica el motivo (acuerdo con el cliente).' }
      if (ref.length > 120) return { ok: false, mensaje: 'El motivo de «sin salida de dinero» es demasiado largo (máximo 120 caracteres).' }
      out.push({ mode: 'SIN_SALIDA', method: null, amount: s(c(r.amount)), reference: ref })
    } else {
      return { ok: false, mensaje: 'Ese modo de reembolso no existe.' }
    }
  }
  const total = out.reduce((a, r) => a + c(r.amount), 0)
  if (total !== pagado.netoCent) {
    return { ok: false, mensaje: `Los reembolsos suman ${s(total).toFixed(2)} y el cliente pagó ${s(pagado.netoCent).toFixed(2)}: deben coincidir (lo que no se devuelve va como «sin salida de dinero», con su motivo).` }
  }
  return { ok: true, reembolsos: out }
}

/** ¿Algún reembolso sale del cajón? Entonces hace falta un turno abierto. */
export const necesitaCaja = (r: readonly ReembolsoValido[]) => r.some((x) => x.mode === 'CAJA')

/** ¿Alguno de los reembolsos mueve dinero (sale del cajón o se devuelve por otro medio)? Solo `SIN_SALIDA` no lo mueve. Quien lo ejecuta necesita SU turno abierto (F6.8b). */
export const mueveDinero = (r: readonly ReembolsoValido[]) => r.some((x) => x.mode !== 'SIN_SALIDA')
export const efectivoDelCajon = (r: readonly ReembolsoValido[]) => redondearCentimos(r.filter((x) => x.mode === 'CAJA').reduce((a, x) => a + x.amount, 0))

// ─── Comprobante ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export type EstadoComprobante = 'PENDIENTE' | 'ENVIADO' | 'ACEPTADO' | 'OBSERVADO' | 'RECHAZADO' | 'ANULADO'
export type PlanComprobante =
  | { accion: 'NINGUNA' }
  | { accion: 'MARCAR_ENSAYO' }
  | { accion: 'EMITIR_NOTA'; codigo: '01' | '06' }
  | { accion: 'BLOQUEAR'; mensaje: string }

/**
 * Qué hacer con el comprobante de la venta:
 *  · ninguno, rechazado o anulado → nada (no está vivo).
 *  · de ensayo → se marca anulado, sin nota (no tiene valor fiscal).
 *  · ACEPTADO u OBSERVADO → nota de crédito total (01 al anular, 06 al devolver). Observado = válido con advertencias.
 *  · PENDIENTE o ENVIADO → se BLOQUEA: sigue en la cola fiscal y la nota solo puede emitirse cuando SUNAT lo acepte.
 */
export function planDeComprobante(doc: { estado: EstadoComprobante; isTrial: boolean; numero: string } | null, tipo: TipoDevolucion): PlanComprobante {
  if (!doc) return { accion: 'NINGUNA' }
  if (doc.isTrial) return { accion: 'MARCAR_ENSAYO' }
  if (doc.estado === 'RECHAZADO' || doc.estado === 'ANULADO') return { accion: 'NINGUNA' }
  if (doc.estado === 'PENDIENTE' || doc.estado === 'ENVIADO') {
    return { accion: 'BLOQUEAR', mensaje: `El comprobante ${doc.numero} aún está en la cola fiscal (${doc.estado.toLowerCase()}). Espera la respuesta de SUNAT, o resuélvelo, antes de anular o devolver la venta.` }
  }
  return { accion: 'EMITIR_NOTA', codigo: CODIGO_NOTA[tipo] }
}

// ─── Crédito ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type PlanCredito =
  | { accion: 'NINGUNA' }
  | { accion: 'CANCELAR_CUENTA'; montoCent: number }
  | { accion: 'BLOQUEAR'; mensaje: string }

export interface CuentaDeVenta { status: 'ABIERTA' | 'PAGADA' | 'ANULADA'; amount: number; paidAmount: number }
export interface AbonoAplicado { fecha: string; monto: number; metodo: string }

/**
 * Venta fiada: sin abonos se cancela la cuenta y se libera la deuda del cliente. CON abonos se rechaza: un abono puede estar repartido entre
 * varias cuentas, así que primero hay que anularlo (`credito.castigar`; y si es de un turno cerrado, con un movimiento manual de caja, F6.3).
 */
export function planDeCredito(cuenta: CuentaDeVenta | null, abonos: readonly AbonoAplicado[]): PlanCredito {
  if (!cuenta) return { accion: 'NINGUNA' }
  if (c(cuenta.paidAmount) > 0) {
    const lista = abonos.length > 0 ? abonos.map((a) => `${a.fecha}: S/ ${a.monto.toFixed(2)} (${a.metodo.toLowerCase()})`).join('; ') : `S/ ${cuenta.paidAmount.toFixed(2)} abonados`
    return {
      accion: 'BLOQUEAR',
      mensaje: `Esta venta fiada ya tiene abonos (${lista}). Primero anula esos abonos desde la ficha del cliente (quien tiene permiso para dar de baja deudas): si son de un turno de caja que ya cerró, el sistema registra su compensación en la caja abierta de hoy. Después vuelve a devolver la venta.`,
    }
  }
  if (cuenta.status === 'ANULADA') return { accion: 'NINGUNA' }
  return { accion: 'CANCELAR_CUENTA', montoCent: c(cuenta.amount) }
}

// ─── Producto dado de baja ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Los productos con control de stock que ya no existen (dados de baja): no pueden recibir el stock de vuelta. */
export function productosDadosDeBaja(lineas: readonly { nombre: string; trackStock: boolean; dadoDeBaja: boolean }[]): string[] {
  return [...new Set(lineas.filter((l) => l.trackStock && l.dadoDeBaja).map((l) => l.nombre))]
}
