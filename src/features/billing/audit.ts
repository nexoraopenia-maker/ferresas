import type { Prisma } from '@/generated/prisma/client'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import type { TenantContext } from '@/lib/tenant-context'

/**
 * Auditoría de facturación.
 *
 * ─── POR QUÉ EXISTE ──────────────────────────────────────────────────────
 *
 * No existía, y se descubrió por el camino equivocado: al intentar contar
 * cuántas veces un ADMIN había contratado un plan —para saber si restringir
 * ese permiso rompía algo— resultó que NO HABÍA NADA QUE CONTAR. Ni
 * `createCheckoutSession` ni `createMercadoPagoCheckout` escribían en
 * AuditLog.
 *
 * O sea: la acción que mueve el dinero del dueño era la única sin rastro.
 * Decir «0 veces» habría sido confundir «no pasó» con «no se registró».
 *
 * ─── POR QUÉ NO ROMPE EL PAGO DE UN MOROSO ───────────────────────────────
 *
 * Los checkouts declaran que no escriben en la BD para que una cuenta en
 * READ_ONLY pueda pagar. Auditarlos sería una escritura, y el guard de
 * `getTenantPrisma` la cortaría — bloqueando a quien más necesita pagar.
 *
 * La solución está en el guard, no aquí: `AuditLog` queda exento del bloqueo
 * por estado de cuenta, porque un registro de auditoría no es una mutación
 * de negocio sino la constancia de algo que ya pasó. Ver la nota en
 * `src/lib/tenant-prisma.ts`.
 *
 * ─── POR QUÉ NUNCA LANZA ─────────────────────────────────────────────────
 *
 * Si la auditoría falla, la operación de pago NO debe fallar. Perder una
 * línea de registro es malo; impedir que un cliente pague porque el registro
 * no se pudo escribir es peor, y encima convierte un problema de observación
 * en una caída de ingresos. El fallo se registra en el log del servidor.
 */

export type AccionFacturacion =
  | 'billing.checkout.iniciado'
  | 'billing.checkout.aprobado'
  | 'billing.checkout.fallido'
  | 'billing.checkout.cancelado'

export interface DatosFacturacion {
  proveedor: 'STRIPE' | 'MERCADOPAGO' | 'MANUAL'
  /** Código del plan que se contrata. */
  planNuevo: string | null
  /** Código del plan que tenía antes, para ver el movimiento. */
  planAnterior: string | null
  /** Importe y moneda, como los cobra el proveedor. */
  monto: string | null
  moneda: string | null
  /** Id de la sesión o preapproval, para cruzar con el panel del proveedor. */
  referenciaExterna: string | null
  /** Estado de la suscripción antes de la operación. */
  estadoAnterior: string | null
  /** Motivo del fallo o de la cancelación, si lo hay. */
  motivo: string | null
}

/**
 * Registra una acción de facturación.
 *
 * `ctx` es opcional porque el webhook llega SIN sesión: lo autentica la firma
 * HMAC del proveedor, no una cookie. En ese caso el actor queda nulo y el
 * registro dice que lo movió el proveedor, que es la verdad.
 */
export async function auditarFacturacion(
  db: TenantPrismaClient,
  tenantId: string,
  accion: AccionFacturacion,
  datos: Partial<DatosFacturacion>,
  ctx?: TenantContext,
): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        tenantId,
        actorId: ctx?.userId ?? null,
        actorRole: ctx?.role ?? null,
        action: accion,
        entityType: 'Subscription',
        entityId: datos.referenciaExterna ?? null,
        reason: datos.motivo ?? null,
        before: {
          plan: datos.planAnterior ?? null,
          estado: datos.estadoAnterior ?? null,
        } as Prisma.InputJsonValue,
        after: {
          plan: datos.planNuevo ?? null,
          proveedor: datos.proveedor ?? null,
          monto: datos.monto ?? null,
          moneda: datos.moneda ?? null,
          referencia: datos.referenciaExterna ?? null,
        } as Prisma.InputJsonValue,
        impersonationId: ctx?.impersonationId ?? null,
      },
    })
  } catch (e) {
    console.error('[billing] no se pudo auditar', {
      accion,
      tenantId,
      proveedor: datos.proveedor,
      error: e instanceof Error ? e.message : e,
    })
  }
}
