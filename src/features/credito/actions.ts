'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { getTenantPrisma, type TenantPrismaClient } from '@/lib/tenant-prisma'
import { requireTenantContext } from '@/lib/session'
import { requireBranch, type TenantContext } from '@/lib/tenant-context'
import { isBusinessError, type ActionResult } from '@/lib/errors'
import { turnoAbiertoId } from '@/features/branches/queries'
import {
  anularAbono as runAnularAbono, anularCuenta as runAnularCuenta, configurarCredito as runConfigurarCredito,
  descartarRevision as runDescartarRevision, infoCreditoCliente as runInfoCreditoCliente, registrarAbono as runRegistrarAbono,
  type AbonoRegistrado, type CreditoConfigurado,
} from './credito-service'
import type { InfoCreditoCliente } from './reglas'
import {
  anularAbonoSchema, anularCuentaSchema, configurarCreditoSchema, descartarRevisionSchema, registrarAbonoSchema,
} from './schemas'

/**
 * Server Actions del crédito para las pantallas. Mismo guion que el resto: sesión en el servidor, Zod antes de la base, el servicio con
 * sus permisos y su bloqueo del cliente, y resultado tipado hacia la UI. Aquí NO hay lógica de dinero ni de permisos: se delega por
 * completo en `credito-service`, que es lo que está probado.
 */

function invalida(error: z.ZodError): ActionResult<never> {
  return { ok: false, code: 'VALIDATION', message: error.issues[0]?.message ?? 'Revisa los datos.', details: z.flattenError(error).fieldErrors }
}

async function conTenant<T>(accion: string, fn: (db: TenantPrismaClient, ctx: TenantContext) => Promise<T>): Promise<ActionResult<T>> {
  let ctx: TenantContext | null = null
  try {
    ctx = await requireTenantContext()
    return { ok: true, data: await fn(getTenantPrisma(ctx), ctx) }
  } catch (e) {
    if (isBusinessError(e)) return { ok: false, code: e.code, message: e.message, details: e.details }
    console.error('[credito] fallo inesperado', { accion, tenantId: ctx?.tenantId ?? null, error: e instanceof Error ? { name: e.name, message: e.message } : e })
    return { ok: false, code: 'TENANT_MISMATCH', message: 'No pudimos completar la operación. Intenta de nuevo.' }
  }
}

/** Refresca lo que muestra deuda: la ficha del cliente, la lista, la cobranza y el panel. */
function refrescar(customerId?: string) {
  revalidatePath('/clientes')
  if (customerId) revalidatePath(`/clientes/${customerId}`)
  revalidatePath('/cobranza')
  revalidatePath('/panel')
}

/** Ficha de crédito del cliente asignado a la venta. Solo lectura. */
export async function infoCreditoCliente(customerId: string): Promise<ActionResult<InfoCreditoCliente>> {
  if (typeof customerId !== 'string' || customerId.length === 0 || customerId.length > 64) {
    return { ok: false, code: 'VALIDATION', message: 'Cliente no válido.' }
  }
  return conTenant('infoCreditoCliente', (db, ctx) => runInfoCreditoCliente(db, ctx, customerId))
}

/** ¿Hay un turno de caja abierto en mi sucursal? Para avisar ANTES de intentar un abono en efectivo. Solo lectura. */
export async function cajaAbiertaParaAbonos(): Promise<ActionResult<{ abierta: boolean }>> {
  return conTenant('cajaAbiertaParaAbonos', async (db, ctx) => ({ abierta: (await turnoAbiertoId(db, requireBranch(ctx))) !== null }))
}

/** Registra un abono. La clave de idempotencia es obligatoria: un reintento devuelve el mismo abono. */
export async function registrarAbono(raw: unknown): Promise<ActionResult<AbonoRegistrado>> {
  const p = registrarAbonoSchema.safeParse(raw)
  if (!p.success) return invalida(p.error)
  const r = await conTenant('registrarAbono', (db, ctx) => runRegistrarAbono(db, ctx, p.data))
  if (r.ok) refrescar(p.data.customerId)
  return r
}

export async function anularAbono(raw: unknown): Promise<ActionResult<{ paymentId: string; deudaDespues: number }>> {
  const p = anularAbonoSchema.safeParse(raw)
  if (!p.success) return invalida(p.error)
  const r = await conTenant('anularAbono', (db, ctx) => runAnularAbono(db, ctx, p.data))
  if (r.ok) refrescar()
  return r
}

/** Da de baja una cuenta por cobrar (castigo). */
export async function anularCuenta(raw: unknown): Promise<ActionResult<{ receivableId: string; saldoCastigado: number; deudaDespues: number }>> {
  const p = anularCuentaSchema.safeParse(raw)
  if (!p.success) return invalida(p.error)
  const r = await conTenant('anularCuenta', (db, ctx) => runAnularCuenta(db, ctx, p.data))
  if (r.ok) refrescar()
  return r
}

/** Resuelve la marca que dejó una nota de crédito sobre una cuenta, manteniéndola como deuda. */
export async function descartarRevision(raw: unknown): Promise<ActionResult<{ receivableId: string }>> {
  const p = descartarRevisionSchema.safeParse(raw)
  if (!p.success) return invalida(p.error)
  const r = await conTenant('descartarRevision', (db, ctx) => runDescartarRevision(db, ctx, p.data))
  if (r.ok) refrescar()
  return r
}

/** Cambia la línea, el plazo o el bloqueo de un cliente. */
export async function configurarCredito(raw: unknown): Promise<ActionResult<CreditoConfigurado>> {
  const p = configurarCreditoSchema.safeParse(raw)
  if (!p.success) return invalida(p.error)
  const r = await conTenant('configurarCredito', (db, ctx) => runConfigurarCredito(db, ctx, p.data))
  if (r.ok) refrescar(p.data.customerId)
  return r
}
