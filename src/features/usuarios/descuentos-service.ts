import type { Role } from '@/generated/prisma/enums'
import { BusinessError } from '@/lib/errors'
import { tieneMaxDecimales } from '@/lib/dinero'
import { topeDeRol } from '@/lib/descuentos'
import { exigir, puede } from '@/lib/puede'
import type { TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'

/**
 * Tope de descuento por rol (ver `src/lib/descuentos.ts`).
 *
 * Lo configura quien gestiona usuarios, con una excepción: el tope del ADMIN lo
 * fija solo el DUEÑO. Si un administrador pudiera subir el suyo, el tope no
 * limitaría a nadie. El del dueño no se limita; ALMACENERO y CONTADOR no venden.
 */

export const ROLES_CON_TOPE = ['ADMIN', 'VENDEDOR', 'CAJERO'] as const
export type RolConTope = (typeof ROLES_CON_TOPE)[number]

/** Roles cuyo tope solo puede tocar el DUEÑO (si no, quien lo limita lo subiría). */
const SOLO_EL_DUENO: ReadonlySet<string> = new Set<RolConTope>(['ADMIN'])
const TIENEN_TOPE: ReadonlySet<string> = new Set(ROLES_CON_TOPE)

export interface TopeVista {
  role: RolConTope
  maxPercent: number
  /** El que mira puede cambiarlo. */
  editable: boolean
  /** Solo el dueño puede cambiarlo (se usa para explicarlo en pantalla). */
  soloDueno: boolean
}

export async function listarTopes(db: TenantPrismaClient, ctx: TenantContext): Promise<TopeVista[]> {
  exigir(ctx, 'usuarios.gestionar')
  const filas = await db.discountCap.findMany({ select: { role: true, maxPercent: true } })
  const topes = Object.fromEntries(filas.map((f) => [f.role, Number(f.maxPercent)])) as Partial<Record<Role, number>>
  return ROLES_CON_TOPE.map((role) => ({
    role,
    maxPercent: topeDeRol(role, topes),
    editable: SOLO_EL_DUENO.has(role) ? puede(ctx, 'plan.gestionar') : true,
    soloDueno: SOLO_EL_DUENO.has(role),
  }))
}

export async function fijarTope(
  db: TenantPrismaClient,
  ctx: TenantContext,
  input: { role: string; maxPercent: number },
): Promise<void> {
  exigir(ctx, 'usuarios.gestionar')

  if (!TIENEN_TOPE.has(input.role)) {
    throw new BusinessError('INVALID_DOCUMENT', 'Ese rol no tiene tope de descuento: el dueño no se limita y el almacenero y el contador no venden.')
  }
  const role = input.role as RolConTope
  if (SOLO_EL_DUENO.has(role) && !puede(ctx, 'plan.gestionar')) {
    throw new BusinessError('FORBIDDEN_ROLE', 'Solo el dueño puede fijar el tope de descuento del administrador.')
  }
  if (!Number.isFinite(input.maxPercent) || input.maxPercent < 0 || input.maxPercent > 100 || !tieneMaxDecimales(input.maxPercent, 2)) {
    throw new BusinessError('INVALID_DOCUMENT', 'El tope es un porcentaje entre 0 y 100, con hasta 2 decimales.')
  }

  const antes = await db.discountCap.findFirst({ where: { role }, select: { maxPercent: true } })
  await db.$transaction(async (tx) => {
    const t = tx as unknown as TenantPrismaClient
    await t.discountCap.upsert({
      where: { tenantId_role: { tenantId: ctx.tenantId, role } },
      create: { tenantId: ctx.tenantId, role, maxPercent: input.maxPercent, updatedById: ctx.userId },
      update: { maxPercent: input.maxPercent, updatedById: ctx.userId },
    })
    await t.auditLog.create({
      data: {
        tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role,
        action: 'descuento.tope', entityType: 'DiscountCap', entityId: role,
        before: { maxPercent: antes ? Number(antes.maxPercent) : topeDeRol(role) },
        after: { maxPercent: input.maxPercent },
        impersonationId: ctx.impersonationId ?? null,
      },
    })
  })
}
