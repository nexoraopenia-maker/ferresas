'use server'

import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { z } from 'zod'
import { getTenantPrisma, type TenantPrismaClient } from '@/lib/tenant-prisma'
import { requireTenantContext } from '@/lib/session'
import { exigir } from '@/lib/puede'
import { isBusinessError, type ActionResult } from '@/lib/errors'
import { BRANCH_COOKIE } from '@/lib/branch-selection'
import type { TenantContext } from '@/lib/tenant-context'
import {
  assignBranchesSchema, createBranchSchema, deleteBranchSchema, updateBranchSchema,
} from './schemas'
import { closeCashSchema, openCashSchema } from './cash-schemas'
import {
  approveTransferSchema, createTransferSchema, receiveTransferSchema,
  rejectTransferSchema, shipTransferSchema,
} from './transfer-schemas'
import {
  assignBranches as runAssign, createBranch as runCreate,
  deleteBranch as runDelete, updateBranch as runUpdate,
} from './branch-service'
import {
  closeCashSession as runClose, currentCashSession as runCurrent,
  openCashSession as runOpen,
} from './cash-service'
import {
  approveTransfer as runApprove, createTransfer as runCreateTransfer,
  receiveTransfer as runReceive, rejectTransfer as runReject,
  shipTransfer as runShip,
} from './transfer-service'

/**
 * Server Actions de sucursales, caja y transferencias.
 *
 * Mismo guion que el resto: sesión resuelta en el servidor, Zod antes de
 * tocar la base, transacción dentro del servicio y resultado tipado hacia la
 * UI. El rol se comprueba en el SERVICIO, no aquí: una Server Action es un
 * endpoint HTTP y cualquiera puede invocarla a mano (Frente 1).
 */

function validationFailure(error: z.ZodError, que: string): ActionResult<never> {
  return {
    ok: false,
    code: 'VALIDATION',
    message: `Revisa los datos de ${que}.`,
    details: z.flattenError(error).fieldErrors,
  }
}

async function withTenant<T>(
  accion: string,
  fn: (db: TenantPrismaClient, ctx: TenantContext) => Promise<ActionResult<T>>,
): Promise<ActionResult<T>> {
  let ctx: TenantContext | null = null
  try {
    ctx = await requireTenantContext()
    return await fn(getTenantPrisma(ctx), ctx)
  } catch (e) {
    if (isBusinessError(e)) {
      return { ok: false, code: e.code, message: e.message, details: e.details }
    }
    console.error('[sucursales] fallo inesperado', {
      accion,
      tenantId: ctx?.tenantId ?? null,
      error: e instanceof Error ? { name: e.name, message: e.message } : e,
    })
    return {
      ok: false,
      code: 'TENANT_MISMATCH',
      message: 'No pudimos completar la operación. Intenta de nuevo.',
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  SUCURSALES
// ═══════════════════════════════════════════════════════════════════════════

export async function createBranch(raw: unknown) {
  const parsed = createBranchSchema.safeParse(raw)
  if (!parsed.success) return validationFailure(parsed.error, 'la sucursal')

  return withTenant('createBranch', async (db, ctx) => {
    const r = await runCreate(db, ctx, parsed.data)
    revalidatePath('/sucursales')
    return { ok: true as const, data: r }
  })
}

export async function updateBranch(raw: unknown) {
  const parsed = updateBranchSchema.safeParse(raw)
  if (!parsed.success) return validationFailure(parsed.error, 'la sucursal')

  return withTenant('updateBranch', async (db, ctx) => {
    const r = await runUpdate(db, ctx, parsed.data)
    revalidatePath('/sucursales')
    return { ok: true as const, data: r }
  })
}

export async function deleteBranch(raw: unknown) {
  const parsed = deleteBranchSchema.safeParse(raw)
  if (!parsed.success) return validationFailure(parsed.error, 'la baja')

  return withTenant('deleteBranch', async (db, ctx) => {
    const r = await runDelete(db, ctx, parsed.data)
    revalidatePath('/sucursales')
    return { ok: true as const, data: r }
  })
}

export async function assignBranches(raw: unknown) {
  const parsed = assignBranchesSchema.safeParse(raw)
  if (!parsed.success) return validationFailure(parsed.error, 'la asignación')

  return withTenant('assignBranches', async (db, ctx) => {
    const r = await runAssign(db, ctx, parsed.data)
    revalidatePath('/sucursales')
    return { ok: true as const, data: r }
  })
}

/**
 * Cambia la sucursal en la que opera el usuario.
 *
 * Solo escribe la cookie. La validación de que esa sucursal sea suya ocurre
 * al RESOLVER la sesión (`resolverSucursalActiva`), no aquí: si se validara
 * solo al escribir, una asignación revocada después dejaría al usuario
 * operando un local que ya no le corresponde hasta que volviera a cambiar.
 */
export async function switchBranch(branchId: string) {
  return withTenant('switchBranch', async (db) => {
    const existe = await db.branch.findFirst({
      where: { id: branchId, isActive: true, deletedAt: null },
      select: { id: true },
    })
    if (!existe) {
      return { ok: false as const, code: 'NOT_FOUND' as const, message: 'La sucursal no existe.' }
    }

    const jar = await cookies()
    jar.set(BRANCH_COOKIE, branchId, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
    })

    // Todo el panel depende de la sucursal: stock, ventas, caja, series.
    revalidatePath('/', 'layout')
    return { ok: true as const, data: { branchId } }
  })
}

// ═══════════════════════════════════════════════════════════════════════════
//  CAJA
// ═══════════════════════════════════════════════════════════════════════════

export async function openCash(raw: unknown) {
  const parsed = openCashSchema.safeParse(raw)
  if (!parsed.success) return validationFailure(parsed.error, 'la apertura')

  return withTenant('openCash', async (db, ctx) => {
    const r = await runOpen(db, ctx, parsed.data)
    revalidatePath('/caja')
    return { ok: true as const, data: r }
  })
}

export async function closeCash(raw: unknown) {
  const parsed = closeCashSchema.safeParse(raw)
  if (!parsed.success) return validationFailure(parsed.error, 'el cierre')

  return withTenant('closeCash', async (db, ctx) => {
    const r = await runClose(db, ctx, parsed.data)
    revalidatePath('/caja')
    return { ok: true as const, data: r }
  })
}

export async function currentCash() {
  return withTenant('currentCash', async (db, ctx) => ({
    ok: true as const,
    data: await runCurrent(db, ctx),
  }))
}

// ═══════════════════════════════════════════════════════════════════════════
//  TRANSFERENCIAS
// ═══════════════════════════════════════════════════════════════════════════

export async function createTransfer(raw: unknown) {
  const parsed = createTransferSchema.safeParse(raw)
  if (!parsed.success) return validationFailure(parsed.error, 'la transferencia')

  return withTenant('createTransfer', async (db, ctx) => {
    const r = await runCreateTransfer(db, ctx, parsed.data)
    revalidatePath('/transferencias')
    return { ok: true as const, data: r }
  })
}

export async function approveTransfer(raw: unknown) {
  const parsed = approveTransferSchema.safeParse(raw)
  if (!parsed.success) return validationFailure(parsed.error, 'la aprobación')

  return withTenant('approveTransfer', async (db, ctx) => {
    const r = await runApprove(db, ctx, parsed.data)
    revalidatePath('/transferencias')
    return { ok: true as const, data: r }
  })
}

export async function shipTransfer(raw: unknown) {
  const parsed = shipTransferSchema.safeParse(raw)
  if (!parsed.success) return validationFailure(parsed.error, 'el despacho')

  return withTenant('shipTransfer', async (db, ctx) => {
    const r = await runShip(db, ctx, parsed.data)
    revalidatePath('/transferencias')
    revalidatePath('/inventario')
    return { ok: true as const, data: r }
  })
}

export async function receiveTransfer(raw: unknown) {
  const parsed = receiveTransferSchema.safeParse(raw)
  if (!parsed.success) return validationFailure(parsed.error, 'la recepción')

  return withTenant('receiveTransfer', async (db, ctx) => {
    const r = await runReceive(db, ctx, parsed.data)
    revalidatePath('/transferencias')
    revalidatePath('/inventario')
    return { ok: true as const, data: r }
  })
}

export async function rejectTransfer(raw: unknown) {
  const parsed = rejectTransferSchema.safeParse(raw)
  if (!parsed.success) return validationFailure(parsed.error, 'el rechazo')

  return withTenant('rejectTransfer', async (db, ctx) => {
    const r = await runReject(db, ctx, parsed.data)
    revalidatePath('/transferencias')
    revalidatePath('/inventario')
    return { ok: true as const, data: r }
  })
}

/**
 * Buscador de productos para armar una transferencia.
 *
 * Devuelve el stock DISPONIBLE en el almacén de origen, no el global: pedir
 * 50 sacos de un almacén que tiene 8 es un viaje perdido, y el dato tiene que
 * estar a la vista en el momento de teclear la cantidad, no al despachar.
 */
export async function searchForTransfer(q: string, fromWarehouseId: string) {
  return withTenant('searchForTransfer', async (db, ctx) => {
    /*
     * Faltaba el permiso. Cualquier usuario con sesión podía consultar
     * nombre y saldo de cualquier producto de cualquier almacén de su negocio
     * a través de este buscador, sin que ninguna pantalla se lo ofreciera —
     * una Server Action es un endpoint HTTP y se puede invocar a mano. Lo
     * detectó la revisión de qué acciones no pasaban por `puede()`.
     */
    exigir(ctx, 'stock.transferir_solicitar')
    const termino = q.trim()
    if (termino.length < 2) return { ok: true as const, data: [] }

    const productos = await db.product.findMany({
      where: {
        deletedAt: null,
        isActive: true,
        trackStock: true,
        OR: [
          { name: { contains: termino, mode: 'insensitive' } },
          { sku: { contains: termino, mode: 'insensitive' } },
          { barcode: termino },
        ],
      },
      take: 12,
      orderBy: { name: 'asc' },
      select: {
        id: true, name: true, sku: true, unitType: true,
        stocks: {
          where: { warehouseId: fromWarehouseId },
          select: { quantity: true },
        },
      },
    })

    return {
      ok: true as const,
      data: productos.map((p) => ({
        productId: p.id,
        name: p.name,
        sku: p.sku,
        unitType: p.unitType,
        disponible: Number(p.stocks[0]?.quantity ?? 0),
      })),
    }
  })
}
