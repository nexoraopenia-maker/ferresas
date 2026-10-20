import { Prisma } from '@/generated/prisma/client'
import { camposDeColision, esColisionUnica } from '@/lib/prisma-errors'
import { BusinessError } from '@/lib/errors'
import { type TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { exigirLimitePlan } from '@/lib/plan-limits'
import { siguienteSeriesNumber } from './series'
import type {
  AssignBranchesInput, CreateBranchInput, DeleteBranchInput, UpdateBranchInput,
} from './schemas'
import { puede } from '@/lib/puede'

export interface BranchResult {
  id: string
  code: string
  name: string
  establishmentCode: string
  seriesNumber: number
  warehouseId: string | null
}

/**
 * Alta de sucursal.
 *
 * Solo ADMIN o superior: abrir un establecimiento compromete la numeración
 * tributaria del negocio y consume cupo del plan. No es una tarea de
 * mostrador.
 */
export async function createBranch(
  db: TenantPrismaClient,
  ctx: TenantContext,
  input: CreateBranchInput,
): Promise<BranchResult> {
  if (!puede(ctx, 'sucursales.gestionar')) {
    throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para crear sucursales.')
  }

  try {
    return await db.$transaction(async (tx) => {
      const t = tx as unknown as TenantPrismaClient

      await exigirLimitePlan(
        t,
        'maxBranches',
        () => t.branch.count({ where: { deletedAt: null } }),
        { singular: 'sucursal', plural: 'sucursales' },
      )

      /*
       * El número de serie se asigna contando TODAS las sucursales, incluidas
       * las dadas de baja. Su serie quedó quemada junto con los comprobantes
       * que emitieron: reasignarla produciría dos documentos distintos con el
       * mismo número bajo el mismo RUC.
       */
      const usados = await t.branch.findMany({ select: { seriesNumber: true } })
      const seriesNumber =
        input.seriesNumber ?? siguienteSeriesNumber(usados.map((b) => b.seriesNumber))

      const branch = await t.branch.create({
        data: {
          tenantId: ctx.tenantId,
          code: input.code,
          name: input.name,
          establishmentCode: input.establishmentCode,
          seriesNumber,
          address: input.address ?? null,
          ubigeo: input.ubigeo ?? null,
          phone: input.phone ?? null,
          email: input.email ?? null,
          managerId: await validarResponsable(t, input.managerId),
          isDefault: false,
          isActive: true,
        },
        select: { id: true, code: true, name: true, establishmentCode: true, seriesNumber: true },
      })

      /*
       * Un almacén desde el principio. Una sucursal sin almacén no puede
       * recibir stock ni vender, así que crearla "vacía" solo garantiza que
       * el siguiente paso sea descubrir que no funciona.
       */
      let warehouseId: string | null = null
      if (input.crearAlmacen) {
        const w = await t.warehouse.create({
          data: {
            tenantId: ctx.tenantId,
            branchId: branch.id,
            code: `${input.code}-PRIN`.slice(0, 20),
            name: `Almacén ${input.name}`.slice(0, 120),
            isDefault: false,
          },
          select: { id: true },
        })
        warehouseId = w.id
      }

      // Quien la crea queda con acceso: si no, abriría una sucursal en la
      // que no puede entrar y tendría que asignarse a sí mismo acto seguido.
      await t.userBranch.createMany({
        data: [{ tenantId: ctx.tenantId, userId: ctx.userId, branchId: branch.id }],
        skipDuplicates: true,
      })

      await t.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorId: ctx.userId,
          actorRole: ctx.role,
          action: 'branch.create',
          entityType: 'Branch',
          entityId: branch.id,
          after: {
            code: branch.code,
            name: branch.name,
            establishmentCode: branch.establishmentCode,
            seriesNumber: branch.seriesNumber,
          },
          impersonationId: ctx.impersonationId ?? null,
        },
      })

      return { ...branch, warehouseId }
    }, { maxWait: 15_000, timeout: 30_000 })
  } catch (e) {
    throw traducirColision(e)
  }
}

/** Modificación de los datos editables. Código, serie y establecimiento no lo son. */
export async function updateBranch(
  db: TenantPrismaClient,
  ctx: TenantContext,
  input: UpdateBranchInput,
): Promise<{ id: string }> {
  if (!puede(ctx, 'sucursales.gestionar')) {
    throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para editar sucursales.')
  }

  const actual = await db.branch.findFirst({
    where: { id: input.branchId, deletedAt: null },
    select: {
      id: true, name: true, address: true, ubigeo: true,
      phone: true, email: true, managerId: true, isActive: true, isDefault: true,
    },
  })
  if (!actual) throw new BusinessError('NOT_FOUND', 'La sucursal no existe.')

  // Desactivar la casa matriz dejaría al negocio sin sucursal por defecto y
  // sin de dónde sacar series: se bloquea aquí y no en la UI.
  if (actual.isDefault && input.isActive === false) {
    throw new BusinessError(
      'INVALID_DOCUMENT',
      'La casa matriz no se puede desactivar. Marca otra como principal primero.',
    )
  }

  // `Unchecked` y no `BranchUpdateInput`: la variante comprobada exige
  // `manager: { connect: ... }` y aquí se asigna el id plano.
  const data: Prisma.BranchUncheckedUpdateInput = {}
  if (input.name !== undefined) data.name = input.name
  if (input.address !== undefined) data.address = input.address || null
  if (input.ubigeo !== undefined) data.ubigeo = input.ubigeo || null
  if (input.phone !== undefined) data.phone = input.phone || null
  if (input.email !== undefined) data.email = input.email || null
  if (input.isActive !== undefined) data.isActive = input.isActive
  if (input.managerId !== undefined) {
    data.managerId = input.managerId ? await validarResponsable(db, input.managerId) : null
  }

  if (Object.keys(data).length === 0) return { id: actual.id }

  await db.branch.update({ where: { id: actual.id }, data })

  await db.auditLog.create({
    data: {
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      actorRole: ctx.role,
      action: 'branch.update',
      entityType: 'Branch',
      entityId: actual.id,
      before: actual as unknown as Prisma.InputJsonValue,
      after: data as unknown as Prisma.InputJsonValue,
      impersonationId: ctx.impersonationId ?? null,
    },
  })

  return { id: actual.id }
}

/**
 * Baja LÓGICA de una sucursal (Frente 1: nunca DELETE de algo con historial).
 *
 * Se niega si queda stock dentro o si hay transferencias en vuelo. No es
 * burocracia: dar de baja un local con mercadería haría desaparecer ese
 * inventario de todos los reportes sin que nadie lo haya movido ni mermado,
 * y el descuadre aparecería semanas después sin rastro de su origen.
 */
export async function deleteBranch(
  db: TenantPrismaClient,
  ctx: TenantContext,
  input: DeleteBranchInput,
): Promise<{ id: string }> {
  if (!puede(ctx, 'sucursales.gestionar')) {
    throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para dar de baja sucursales.')
  }

  const branch = await db.branch.findFirst({
    where: { id: input.branchId, deletedAt: null },
    select: { id: true, code: true, name: true, isDefault: true },
  })
  if (!branch) throw new BusinessError('NOT_FOUND', 'La sucursal no existe.')

  if (branch.isDefault) {
    throw new BusinessError(
      'INVALID_DOCUMENT',
      'La casa matriz no se da de baja. Marca otra como principal primero.',
    )
  }

  const conStock = await db.stock.count({
    where: { warehouse: { branchId: branch.id }, quantity: { gt: 0 } },
  })
  if (conStock > 0) {
    throw new BusinessError(
      'INVALID_DOCUMENT',
      `La sucursal todavía tiene ${conStock} ${conStock === 1 ? 'producto' : 'productos'} con stock. ` +
        'Transfiere o da de baja el inventario antes de cerrarla.',
      { conStock },
    )
  }

  const enVuelo = await db.branchTransfer.count({
    where: {
      OR: [{ fromBranchId: branch.id }, { toBranchId: branch.id }],
      status: { in: ['SOLICITADA', 'APROBADA', 'EN_TRANSITO'] },
    },
  })
  if (enVuelo > 0) {
    throw new BusinessError(
      'INVALID_DOCUMENT',
      `Hay ${enVuelo} ${enVuelo === 1 ? 'transferencia' : 'transferencias'} sin cerrar con esta sucursal.`,
      { enVuelo },
    )
  }

  const cajaAbierta = await db.cashSession.count({
    where: { branchId: branch.id, status: 'ABIERTA' },
  })
  if (cajaAbierta > 0) {
    throw new BusinessError('INVALID_DOCUMENT', 'Cierra la caja de la sucursal antes de darla de baja.')
  }

  await db.$transaction(async (tx) => {
    const t = tx as unknown as TenantPrismaClient
    await t.branch.update({
      where: { id: branch.id },
      data: { deletedAt: new Date(), isActive: false },
    })
    // Los almacenes de dentro se desactivan con ella: dejarlos activos los
    // mantendría seleccionables en los desplegables del POS.
    await t.warehouse.updateMany({
      where: { branchId: branch.id },
      data: { isActive: false },
    })
    await t.auditLog.create({
      data: {
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        actorRole: ctx.role,
        action: 'branch.delete',
        entityType: 'Branch',
        entityId: branch.id,
        reason: input.reason,
        before: { code: branch.code, name: branch.name },
        impersonationId: ctx.impersonationId ?? null,
      },
    })
  })

  return { id: branch.id }
}

/**
 * Fija las sucursales de un usuario, reemplazando las que tenía.
 *
 * Se recibe la lista COMPLETA y no un "añadir/quitar" para que la operación
 * sea idempotente: reenviar la misma petición deja el mismo estado, y no hay
 * forma de que dos pestañas abiertas acaben dejando al usuario con una mezcla
 * de ambas.
 */
export async function assignBranches(
  db: TenantPrismaClient,
  ctx: TenantContext,
  input: AssignBranchesInput,
): Promise<{ userId: string; asignadas: number }> {
  if (!puede(ctx, 'usuarios.gestionar')) {
    throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para asignar sucursales.')
  }

  const usuario = await db.user.findFirst({
    where: { id: input.userId, deletedAt: null },
    select: { id: true, email: true, role: true },
  })
  if (!usuario) throw new BusinessError('NOT_FOUND', 'El usuario no existe.')

  // Todas las sucursales pedidas tienen que existir y estar vigentes: una id
  // inventada se rechaza en bloque en vez de asignar las que sí valen.
  const validas = await db.branch.findMany({
    where: { id: { in: input.branchIds }, deletedAt: null },
    select: { id: true },
  })
  if (validas.length !== input.branchIds.length) {
    throw new BusinessError(
      'NOT_FOUND',
      'Alguna de las sucursales indicadas no existe o está dada de baja.',
    )
  }

  await db.$transaction(async (tx) => {
    const t = tx as unknown as TenantPrismaClient
    await t.userBranch.deleteMany({ where: { userId: usuario.id } })
    if (validas.length > 0) {
      await t.userBranch.createMany({
        data: validas.map((b) => ({
          tenantId: ctx.tenantId,
          userId: usuario.id,
          branchId: b.id,
        })),
      })
    }
    await t.auditLog.create({
      data: {
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        actorRole: ctx.role,
        action: 'branch.assign',
        entityType: 'User',
        entityId: usuario.id,
        after: { email: usuario.email, sucursales: validas.map((b) => b.id) },
        impersonationId: ctx.impersonationId ?? null,
      },
    })
  })

  return { userId: usuario.id, asignadas: validas.length }
}

/** El responsable tiene que ser un usuario vigente DEL MISMO tenant. */
async function validarResponsable(
  db: TenantPrismaClient,
  managerId: string | undefined,
): Promise<string | null> {
  if (!managerId) return null
  const u = await db.user.findFirst({
    where: { id: managerId, isActive: true, deletedAt: null },
    select: { id: true },
  })
  if (!u) throw new BusinessError('NOT_FOUND', 'El responsable indicado no existe.')
  return u.id
}

/**
 * Traduce las colisiones de índice a mensajes que el dueño entienda.
 * Sin esto, abrir una sucursal con un código repetido devuelve "P2002" y el
 * usuario no sabe qué campo corregir.
 */
function traducirColision(e: unknown): unknown {
  if (!esColisionUnica(e)) return e
  const campos = camposDeColision(e)
  if (campos.includes('establishmentCode')) {
    return new BusinessError(
      'DUPLICATE_CODE',
      'Ya existe una sucursal con ese código de establecimiento. ' +
        'SUNAT asigna uno distinto a cada anexo del RUC.',
    )
  }
  if (campos.includes('seriesNumber')) {
    return new BusinessError(
      'DUPLICATE_CODE',
      'Ese número de serie ya está en uso por otra sucursal, incluso si está dada de baja.',
    )
  }
  if (campos.includes('code')) {
    return new BusinessError('DUPLICATE_CODE', 'Ya existe una sucursal con ese código.')
  }
  return e
}
