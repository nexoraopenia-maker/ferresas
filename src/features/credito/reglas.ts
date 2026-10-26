import { BusinessError } from '@/lib/errors'
import { validarDocumento } from '@/lib/documentos'

/**
 * Reglas PURAS del crédito: sin base de datos ni dependencias de servidor, para que las use tanto el servicio (que decide) como la
 * pantalla del POS (que anticipa). Una sola fuente: la ficha del cliente dice «no se puede fiar» por la MISMA función que lo
 * rechazaría el servidor, y los mensajes son los mismos.
 */

const aCentimos = (n: number) => Math.round(n * 100)
const deCentimos = (c: number) => c / 100

/** Hoy (AAAA-MM-DD) en la zona horaria del negocio: un fiado de las 11 pm no vence «mañana» por culpa del reloj del servidor. */
export function hoyEnZona(zona: string, ahora: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zona, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ahora)
}

/** Fecha sin hora (UTC medianoche) = `fecha` + `dias`. Es lo que guarda una columna `@db.Date`. */
export function sumarDias(fecha: string, dias: number): Date {
  const [y, m, d] = fecha.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d + dias))
}

/** Lo que hace falta saber de un cliente para decidir si se le puede fiar. */
export interface ClienteCredito {
  name: string
  docType: string
  docNumber: string | null
  isActive: boolean
  deletedAt: Date | null
  creditLimit: number
  creditBalance: number
  creditBlockedAt: Date | null
  creditTermDays: number
}

/** El cliente tiene un DNI o RUC válido: no se fía a «público general» ni a quien no se podría cobrar. */
export function tieneDocumentoValido(c: Pick<ClienteCredito, 'docType' | 'docNumber'>): boolean {
  if (c.docType === 'SIN_DOCUMENTO' || !c.docNumber) return false
  return validarDocumento(c.docNumber).valido
}

/**
 * ¿Se le puede fiar `monto` a este cliente? Lanza el error que corresponde, o no hace nada. Lógica pura: se prueba sin base.
 * Orden: de baja → sin documento → bloqueado → sin línea → supera la línea.
 */
export function validarFiado(c: ClienteCredito, monto: number): void {
  if (c.deletedAt || !c.isActive) throw new BusinessError('CREDIT_BLOCKED', 'El cliente está dado de baja: no se le puede vender a crédito.')
  if (!tieneDocumentoValido(c)) {
    throw new BusinessError('CREDIT_CUSTOMER', 'Para fiar el cliente necesita un DNI o RUC válido: no se fía a «público general».')
  }
  if (c.creditBlockedAt) throw new BusinessError('CREDIT_BLOCKED', 'El crédito de este cliente está bloqueado.')
  const limite = aCentimos(c.creditLimit)
  if (limite <= 0) throw new BusinessError('CREDIT_BLOCKED', 'Este cliente no tiene línea de crédito.')
  const deuda = aCentimos(c.creditBalance)
  const M = aCentimos(monto)
  if (deuda + M > limite) {
    const disponible = Math.max(0, limite - deuda)
    throw new BusinessError(
      'CREDIT_LIMIT',
      mensajeSuperaLinea(deCentimos(limite), deCentimos(disponible)),
      { limite: deCentimos(limite), deuda: deCentimos(deuda), monto: deCentimos(M), disponible: deCentimos(disponible) },
    )
  }
}

/** El texto exacto con que el servidor rechaza un fiado que pasa la línea; la pantalla usa el mismo. */
export function mensajeSuperaLinea(limite: number, disponible: number): string {
  return `Supera la línea de crédito: disponible S/ ${disponible.toFixed(2)} de S/ ${limite.toFixed(2)}.`
}

/** ¿Cabe fiar `monto` según la ficha? `null` = sí; si no, el mismo mensaje que daría el servidor. */
export function motivoNoCabe(info: InfoCreditoCliente, monto: number): string | null {
  if (!info.puedeFiar) return info.motivo
  if (aCentimos(info.deuda) + aCentimos(monto) > aCentimos(info.limite)) return mensajeSuperaLinea(info.limite, info.disponible)
  return null
}

export interface CuentaVencible { amount: number; paidAmount: number; dueDate: string }

/** Lo que la pantalla muestra de un cliente antes de fiarle. Importes en soles. */
export interface InfoCreditoCliente {
  customerId: string
  nombre: string
  limite: number
  deuda: number
  disponible: number
  plazoDias: number
  /** Si se fiara hoy: AAAA-MM-DD en la zona del negocio. */
  venceSiFia: string
  bloqueado: boolean
  documentoValido: boolean
  /** Saldo en cuentas ABIERTAS ya vencidas (dueDate < hoy) y cuántas son. Aviso, no bloqueo. */
  vencido: number
  cuentasVencidas: number
  /** ¿Cabe fiar algo ahora? Si no, `motivo` dice por qué (el mismo mensaje que daría el servidor al fiar 0,01). */
  puedeFiar: boolean
  motivo: string | null
}

/** Suma de los saldos de las cuentas abiertas con vencimiento anterior a `hoy` (AAAA-MM-DD; los textos ISO se comparan bien). */
export function resumenVencido(cuentas: readonly CuentaVencible[], hoy: string): { vencido: number; cuentas: number } {
  const v = cuentas.filter((x) => x.dueDate < hoy && aCentimos(x.amount) > aCentimos(x.paidAmount))
  return { vencido: deCentimos(v.reduce((a, x) => a + aCentimos(x.amount) - aCentimos(x.paidAmount), 0)), cuentas: v.length }
}

export function construirInfoCredito(
  customerId: string, c: ClienteCredito, cuentasAbiertas: readonly CuentaVencible[], hoy: string,
): InfoCreditoCliente {
  const limite = aCentimos(c.creditLimit), deuda = aCentimos(c.creditBalance)
  const { vencido, cuentas } = resumenVencido(cuentasAbiertas, hoy)
  let motivo: string | null = null
  try { validarFiado(c, 0.01) } catch (e) { motivo = e instanceof BusinessError ? e.message : 'No se puede fiar.' }
  return {
    customerId, nombre: c.name,
    limite: c.creditLimit, deuda: c.creditBalance, disponible: deCentimos(Math.max(0, limite - deuda)),
    plazoDias: c.creditTermDays, venceSiFia: sumarDias(hoy, c.creditTermDays).toISOString().slice(0, 10),
    bloqueado: c.creditBlockedAt !== null, documentoValido: tieneDocumentoValido(c),
    vencido, cuentasVencidas: cuentas, puedeFiar: motivo === null, motivo,
  }
}


// ─── Reparto de un abono ────────────────────────────────────────────────────────────────────────────────────────────

export interface ParteDeAbono {
  /** Posición de la cuenta en la lista recibida. */
  indice: number
  /** Lo que se le aplica, en soles. */
  monto: number
  /** Lo que le queda por pagar tras este abono. */
  saldoDespues: number
  /** Queda saldada con este abono. */
  pagada: boolean
}

/**
 * Reparte un abono entre cuentas YA ORDENADAS (la más antigua primero, o en el orden que eligió el cajero): llena una cuenta antes de
 * pasar a la siguiente. Lógica pura, en céntimos: la usa el servicio para escribir y la pantalla para mostrar la vista previa, de modo
 * que lo que se ve antes de cobrar es exactamente lo que se registra. No decide si el abono cabe (eso lo rechaza el servicio): un
 * sobrante se devuelve en `sobrante`.
 */
export function repartirAbono(saldos: readonly number[], monto: number): { partes: ParteDeAbono[]; sobrante: number } {
  let resto = aCentimos(monto)
  const partes: ParteDeAbono[] = []
  saldos.forEach((saldo, indice) => {
    const s = aCentimos(saldo)
    if (resto <= 0 || s <= 0) return
    const a = Math.min(resto, s)
    resto -= a
    partes.push({ indice, monto: deCentimos(a), saldoDespues: deCentimos(s - a), pagada: s - a === 0 })
  })
  return { partes, sobrante: deCentimos(resto) }
}

// ─── Antigüedad de la deuda ─────────────────────────────────────────────────────────────────────────────────────────

export const TRAMOS_ANTIGUEDAD = ['vigente', 'mora1a30', 'mora31a60', 'mora61a90', 'mora91omas'] as const
export type TramoAntiguedad = (typeof TRAMOS_ANTIGUEDAD)[number]

export const ETIQUETAS_TRAMO: Record<TramoAntiguedad, string> = {
  vigente: 'Vigente', mora1a30: '1-30 días', mora31a60: '31-60 días', mora61a90: '61-90 días', mora91omas: 'Más de 90 días',
}

/** Días de atraso de una cuenta respecto a `hoy` (AAAA-MM-DD). 0 o menos = aún no vence (vence hoy tampoco está vencida). */
export function diasDeMora(vence: string, hoy: string): number {
  return Math.round((Date.parse(`${hoy}T00:00:00Z`) - Date.parse(`${vence}T00:00:00Z`)) / 86_400_000)
}

export function tramoDeMora(dias: number): TramoAntiguedad {
  if (dias <= 0) return 'vigente'
  if (dias <= 30) return 'mora1a30'
  if (dias <= 60) return 'mora31a60'
  if (dias <= 90) return 'mora61a90'
  return 'mora91omas'
}

export type MontosPorTramo = Record<TramoAntiguedad, number> & { total: number; vencido: number }

/** Suma el SALDO (lo que falta por pagar) de cuentas abiertas en su tramo de antigüedad. «Vigente» va aparte de la mora real. */
export function clasificarAntiguedad(cuentas: readonly CuentaVencible[], hoy: string): MontosPorTramo {
  const c: Record<TramoAntiguedad, number> = { vigente: 0, mora1a30: 0, mora31a60: 0, mora61a90: 0, mora91omas: 0 }
  for (const x of cuentas) {
    const saldo = aCentimos(x.amount) - aCentimos(x.paidAmount)
    if (saldo > 0) c[tramoDeMora(diasDeMora(x.dueDate, hoy))] += saldo
  }
  const total = TRAMOS_ANTIGUEDAD.reduce((a, t) => a + c[t], 0)
  return {
    vigente: deCentimos(c.vigente), mora1a30: deCentimos(c.mora1a30), mora31a60: deCentimos(c.mora31a60),
    mora61a90: deCentimos(c.mora61a90), mora91omas: deCentimos(c.mora91omas), total: deCentimos(total), vencido: deCentimos(total - c.vigente),
  }
}
