'use server'

import { getTenantPrisma } from '@/lib/tenant-prisma'
import { requireTenantContext } from '@/lib/session'
import { isBusinessError, type ActionResult } from '@/lib/errors'
import { infoCreditoCliente as runInfoCreditoCliente } from './credito-service'
import type { InfoCreditoCliente } from './reglas'

/**
 * Server Actions del crédito para las pantallas. Mismo guion que el resto: sesión en el servidor, servicio con sus permisos y
 * resultado tipado hacia la UI. Aquí solo lo que el POS necesita; la gestión de clientes y cobranza llega con el Paso 5.
 */

/** Ficha de crédito del cliente asignado a la venta. Solo lectura. */
export async function infoCreditoCliente(customerId: string): Promise<ActionResult<InfoCreditoCliente>> {
  if (typeof customerId !== 'string' || customerId.length === 0 || customerId.length > 64) {
    return { ok: false, code: 'VALIDATION', message: 'Cliente no válido.' }
  }
  try {
    const ctx = await requireTenantContext()
    return { ok: true, data: await runInfoCreditoCliente(getTenantPrisma(ctx), ctx, customerId) }
  } catch (e) {
    if (isBusinessError(e)) return { ok: false, code: e.code, message: e.message, details: e.details }
    console.error('[credito] fallo inesperado', { accion: 'infoCreditoCliente', error: e instanceof Error ? { name: e.name, message: e.message } : e })
    return { ok: false, code: 'TENANT_MISMATCH', message: 'No pudimos consultar el crédito del cliente. Intenta de nuevo.' }
  }
}
