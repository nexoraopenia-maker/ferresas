/**
 * Errores de negocio tipados (§6.7).
 *
 * Regla: un error de negocio es un RESULTADO ESPERADO, no una excepción
 * genérica. La UI debe poder distinguir "stock insuficiente" (mostrar aviso)
 * de "algo explotó" (mostrar toast rojo y loguear).
 *
 * Ninguno de estos mensajes incluye tenantId, IDs internos ni datos de otro
 * tenant: son texto seguro para mostrar al usuario final (§6.8).
 */

export type BusinessErrorCode =
  | 'UNAUTHENTICATED'
  /** Contraseña correcta, falta el código del segundo factor. */
  | 'MFA_REQUIRED'
  | 'RATE_LIMITED'
  | 'TENANT_MISMATCH'
  | 'SUBSCRIPTION_BLOCKED'
  | 'SUBSCRIPTION_READ_ONLY'
  | 'PLAN_LIMIT_REACHED'
  | 'PLAN_UNAVAILABLE'
  | 'DUPLICATE_CODE'
  | 'INVALID_DOCUMENT'
  /** El recurso no existe, o existe pero en otro tenant: indistinguible a propósito. */
  | 'NOT_FOUND'
  | 'INSUFFICIENT_STOCK'
  | 'FORBIDDEN_ROLE'
  | 'STOCK_CONFLICT'
  /** La venta a crédito superaría la línea del cliente. `details`: límite, deuda, monto y disponible. */
  | 'CREDIT_LIMIT'
  /** El cliente tiene el crédito bloqueado, no tiene línea, o está dado de baja. */
  | 'CREDIT_BLOCKED'
  /** El fiado exige un cliente identificado (DNI/RUC válido): no hay fiado a «público general». */
  | 'CREDIT_CUSTOMER'
  /** La venta fiada ya tiene abonos: no se devuelve hasta anularlos (F6.1). */
  | 'CREDIT_HAS_PAYMENTS'
  /** Hace falta un turno de caja abierto (devolver dinero en efectivo desde el cajón). */
  | 'CASH_REQUIRED'
  /** Un egreso de caja supera el efectivo que el sistema espera en el cajón: se pide confirmación explícita (F6.3). */
  | 'CASH_EXCEEDS_EXPECTED'
  /** La diferencia de una línea de toma de inventario supera el umbral operativo: se recomienda recontar o confirmar expresamente (F6.5b). */
  | 'COUNT_OVER_THRESHOLD'

export class BusinessError extends Error {
  readonly code: BusinessErrorCode
  /** Datos no sensibles para que la UI renderice el detalle. */
  readonly details?: Record<string, string | number>

  constructor(
    code: BusinessErrorCode,
    message: string,
    details?: Record<string, string | number>,
  ) {
    super(message)
    this.name = 'BusinessError'
    this.code = code
    this.details = details
  }
}

/**
 * Fuga de aislamiento detectada. Nunca debería ocurrir en producción: si
 * salta, hay un bug de seguridad. El mensaje al cliente es deliberadamente
 * opaco; el contexto real va al log del servidor.
 */
export class TenantIsolationError extends BusinessError {
  constructor(message = 'Recurso no disponible.') {
    super('TENANT_MISMATCH', message)
    this.name = 'TenantIsolationError'
  }
}

export function isBusinessError(e: unknown): e is BusinessError {
  return e instanceof BusinessError
}

/** Resultado tipado para Server Actions (§6.3, §6.7). */
export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: BusinessErrorCode | 'VALIDATION'; message: string; details?: unknown }
