import { Prisma } from '@/generated/prisma/client'
import { BusinessError } from '@/lib/errors'
import { validarDocumento } from '@/lib/documentos'
import { P2002_UNIQUE } from '@/lib/prisma-errors'
import { exigir, puede } from '@/lib/puede'
import type { TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { hoyEnZona } from '@/features/credito/credito-service'
import { resumenVencido } from '@/features/credito/reglas'
import { PERMISOS_VER_PROVEEDORES, puedeVerProveedores } from './permisos'
import type {
  BajaProveedorInput, CrearProveedorInput, EditarProveedorInput, ListarProveedoresInput, ReactivarProveedorInput,
} from './schemas'

/**
 * Proveedores: alta, edición, baja, lista y ficha. Los datos de la empresa a la que se le compra; el DINERO (compras, cuentas por
 * pagar, pagos) es de los módulos de compras y pagos.
 *
 *  · Gestionar (crear, editar, dar de baja, reactivar): `proveedores.gestionar` (dueño y administrador).
 *  · VER la lista y la ficha: además, quien registra compras o paga (necesita saber a quién).
 *  · El RUC NO se puede cambiar si el proveedor ya tiene compras: cambiaría la identidad de documentos ya registrados.
 *  · La baja es lógica (`deletedAt`) y se rechaza con deuda o con compras en borrador. Nunca se borra una fila.
 *
 * Todo cambio queda en el registro de auditoría con el antes y el después.
 */

export { PERMISOS_VER_PROVEEDORES, puedeVerProveedores }

const num = (d: { toString(): string } | null | undefined) => Number(d?.toString() ?? 0)
const noExiste = () => new BusinessError('NOT_FOUND', 'El proveedor no existe.')
const invalido = (m: string) => new BusinessError('INVALID_DOCUMENT', m)

function exigirVer(ctx: TenantContext): void {
  if (!puedeVerProveedores(ctx)) throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para ver los proveedores.')
}

/** RUC tecleado → RUC normalizado o `null` si no hay. Lanza si no es un RUC válido (un DNI tampoco vale: el proveedor factura con RUC). */
export function resolverRuc(taxId: string | undefined): string | null {
  if (!taxId) return null
  const v = validarDocumento(taxId)
  if (!v.valido) throw invalido(v.mensaje)
  if (v.tipo !== 'RUC') throw invalido('El proveedor se identifica con RUC (11 dígitos), no con DNI.')
  return taxId.trim()
}

const SELECCION = {
  id: true, name: true, taxId: true, contact: true, phone: true, email: true, address: true, notes: true,
  paymentTermDays: true, payableBalance: true, isActive: true, deletedAt: true, createdAt: true, updatedAt: true,
} as const

/** Los campos que un usuario edita, en el orden en que se auditan. */
const CAMPOS = ['name', 'taxId', 'contact', 'phone', 'email', 'address', 'notes', 'paymentTermDays'] as const

/**
 * Bloquea al proveedor y devuelve su fila fresca. Es el primer paso de toda operación que cambia lo que se le debe (recibir una compra
 * a crédito, pagar, anular), como `bloquearCliente`: el `UPDATE` toma la fila y la devuelve ya firme. Dentro de una transacción.
 * «No existe» es lo único que se traduce; otro fallo (una conexión caída) sigue siendo un fallo.
 */
export async function bloquearProveedor(t: TenantPrismaClient, supplierId: string) {
  try {
    const fila = await t.supplier.update({
      where: { id: supplierId }, data: { payableBalance: { increment: 0 } },
      select: { id: true, name: true, taxId: true, paymentTermDays: true, payableBalance: true, isActive: true, deletedAt: true },
    })
    return { ...fila, payableBalance: num(fila.payableBalance) }
  } catch (e) {
    if ((e as { code?: string }).code === 'P2025') throw noExiste()
    throw e
  }
}

// ─── Alta ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export async function crearProveedor(db: TenantPrismaClient, ctx: TenantContext, input: CrearProveedorInput): Promise<{ id: string; name: string }> {
  exigir(ctx, 'proveedores.gestionar')
  const taxId = resolverRuc(input.taxId)

  return db.$transaction(async (tx) => {
    const t = tx as unknown as TenantPrismaClient
    if (taxId) {
      const previo = await t.supplier.findFirst({ where: { taxId }, select: { deletedAt: true } })
      if (previo) {
        throw new BusinessError('DUPLICATE_CODE', previo.deletedAt
          ? 'Ese RUC pertenece a un proveedor dado de baja: reactívalo desde Proveedores en vez de crear otro.'
          : 'Ya existe un proveedor con ese RUC.')
      }
    }
    try {
      const s = await t.supplier.create({
        data: {
          tenantId: ctx.tenantId, name: input.name, taxId, contact: input.contact ?? null, phone: input.phone ?? null,
          email: input.email ?? null, address: input.address ?? null, notes: input.notes ?? null, paymentTermDays: input.paymentTermDays,
        },
        select: { id: true, name: true },
      })
      await t.auditLog.create({
        data: {
          tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role, action: 'proveedor.creado', entityType: 'Supplier', entityId: s.id,
          after: { name: input.name, taxId, paymentTermDays: input.paymentTermDays }, impersonationId: ctx.impersonationId ?? null,
        },
      })
      return s
    } catch (e) {
      // Dos altas con el mismo RUC a la vez: la restricción única de la base decide.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === P2002_UNIQUE) {
        throw new BusinessError('DUPLICATE_CODE', 'Ya existe un proveedor con ese RUC.')
      }
      throw e
    }
  }, { maxWait: 15_000, timeout: 30_000 })
}

// ─── Edición ────────────────────────────────────────────────────────────────────────────────────────────────────────

export async function editarProveedor(db: TenantPrismaClient, ctx: TenantContext, input: EditarProveedorInput): Promise<{ id: string; cambios: string[] }> {
  exigir(ctx, 'proveedores.gestionar')
  const taxId = resolverRuc(input.taxId)

  return db.$transaction(async (tx) => {
    const t = tx as unknown as TenantPrismaClient
    await bloquearProveedor(t, input.supplierId)   // ← primero: nadie recibe una compra ni paga mientras se edita
    const antes = await t.supplier.findFirst({ where: { id: input.supplierId }, select: SELECCION })
    if (!antes) throw noExiste()
    if (antes.deletedAt) throw invalido('El proveedor está dado de baja: reactívalo para editarlo.')

    const nuevo = {
      name: input.name, taxId, contact: input.contact ?? null, phone: input.phone ?? null, email: input.email ?? null,
      address: input.address ?? null, notes: input.notes ?? null, paymentTermDays: input.paymentTermDays,
    }
    const cambia = (k: (typeof CAMPOS)[number]) => (antes[k] ?? null) !== (nuevo[k] ?? null)
    const cambios = CAMPOS.filter(cambia)
    if (cambios.length === 0) return { id: antes.id, cambios: [] }

    if (cambia('taxId')) {
      const compras = await t.purchase.count({ where: { supplierId: antes.id } })
      if (compras > 0) {
        throw invalido('El RUC no se puede cambiar: el proveedor ya tiene compras y alteraría los documentos registrados. Crea otro proveedor si es otra empresa.')
      }
      if (taxId) {
        const otro = await t.supplier.findFirst({ where: { taxId, id: { not: antes.id } }, select: { deletedAt: true } })
        if (otro) throw new BusinessError('DUPLICATE_CODE', otro.deletedAt ? 'Ese RUC pertenece a un proveedor dado de baja.' : 'Ya existe un proveedor con ese RUC.')
      } else if (num(antes.payableBalance) > 0) {
        throw invalido('No se puede quitar el RUC a un proveedor con deuda: no se podría conciliar lo que se le debe.')
      }
    }

    try {
      await t.supplier.update({ where: { id: antes.id }, data: nuevo, select: { id: true } })
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === P2002_UNIQUE) {
        throw new BusinessError('DUPLICATE_CODE', 'Ya existe un proveedor con ese RUC.')
      }
      throw e
    }
    await t.auditLog.create({
      data: {
        tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role, action: 'proveedor.editado', entityType: 'Supplier', entityId: antes.id,
        before: Object.fromEntries(cambios.map((k) => [k, antes[k] ?? null])), after: Object.fromEntries(cambios.map((k) => [k, nuevo[k] ?? null])),
        impersonationId: ctx.impersonationId ?? null,
      },
    })
    return { id: antes.id, cambios }
  }, { maxWait: 15_000, timeout: 30_000 })
}

// ─── Baja y reactivación ────────────────────────────────────────────────────────────────────────────────────────────

export async function darDeBajaProveedor(db: TenantPrismaClient, ctx: TenantContext, input: BajaProveedorInput): Promise<{ id: string }> {
  exigir(ctx, 'proveedores.gestionar')
  return db.$transaction(async (tx) => {
    const t = tx as unknown as TenantPrismaClient
    const s = await bloquearProveedor(t, input.supplierId)   // ← una compra a crédito en curso termina antes de decidir
    if (s.deletedAt) throw invalido('El proveedor ya está dado de baja.')
    if (s.payableBalance > 0) {
      throw new BusinessError('CREDIT_BLOCKED', `Le debes S/ ${s.payableBalance.toFixed(2)} a este proveedor: págalo o anula la compra antes de darlo de baja.`, { deuda: s.payableBalance })
    }
    const borradores = await t.purchase.count({ where: { supplierId: s.id, status: 'BORRADOR' } })
    if (borradores > 0) {
      throw invalido(`Tiene ${borradores} ${borradores === 1 ? 'compra en borrador' : 'compras en borrador'}: recíbelas o anúlalas antes de darlo de baja.`)
    }
    await t.supplier.update({ where: { id: s.id }, data: { deletedAt: new Date(), isActive: false }, select: { id: true } })
    await t.auditLog.create({
      data: {
        tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role, action: 'proveedor.baja', entityType: 'Supplier', entityId: s.id,
        reason: input.motivo, before: { name: s.name }, impersonationId: ctx.impersonationId ?? null,
      },
    })
    return { id: s.id }
  }, { maxWait: 15_000, timeout: 30_000 })
}

export async function reactivarProveedor(db: TenantPrismaClient, ctx: TenantContext, input: ReactivarProveedorInput): Promise<{ id: string }> {
  exigir(ctx, 'proveedores.gestionar')
  return db.$transaction(async (tx) => {
    const t = tx as unknown as TenantPrismaClient
    const s = await bloquearProveedor(t, input.supplierId)
    if (!s.deletedAt) throw invalido('El proveedor ya está activo.')
    await t.supplier.update({ where: { id: s.id }, data: { deletedAt: null, isActive: true }, select: { id: true } })
    await t.auditLog.create({
      data: {
        tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role, action: 'proveedor.reactivado', entityType: 'Supplier', entityId: s.id,
        after: { name: s.name }, impersonationId: ctx.impersonationId ?? null,
      },
    })
    return { id: s.id }
  }, { maxWait: 15_000, timeout: 30_000 })
}

// ─── Lista ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface FilaProveedor {
  id: string; name: string; taxId: string | null; contact: string | null; phone: string | null
  paymentTermDays: number; activo: boolean
  /** Lo que se le debe y la parte ya vencida (con cuántas cuentas). */
  deuda: number; vencido: number; cuentasVencidas: number
}
export interface PaginaProveedores { items: FilaProveedor[]; siguiente: string | null }

export async function listarProveedores(db: TenantPrismaClient, ctx: TenantContext, input: ListarProveedoresInput): Promise<PaginaProveedores> {
  exigirVer(ctx)
  if (input.filtro === 'DE_BAJA' && !puede(ctx, 'proveedores.gestionar')) {
    throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para ver los proveedores dados de baja.')
  }
  const tenant = await db.tenant.findFirstOrThrow({ select: { timezone: true } })
  const hoy = hoyEnZona(tenant.timezone)

  const condiciones: Prisma.SupplierWhereInput[] = [{ deletedAt: input.filtro === 'DE_BAJA' ? { not: null } : null }]
  if (input.q) {
    condiciones.push({ OR: [
      { name: { contains: input.q, mode: 'insensitive' } }, { taxId: { contains: input.q } },
      { contact: { contains: input.q, mode: 'insensitive' } }, { phone: { contains: input.q } },
    ] })
  }
  if (input.filtro === 'CON_DEUDA') condiciones.push({ payableBalance: { gt: 0 } })

  /*
   * El orden alfabético lo hace la aplicación, no la base: Postgres ordena por bytes y mandaría «Ñandú» o «Ángel» detrás de la «Z».
   * Se leen solo id y nombre de lo que coincide, se ordenan con el criterio del español y de ahí se corta la página; el cursor es la
   * posición del último id. Para el tamaño de una ferretería es de sobra.
   */
  const candidatos = await db.supplier.findMany({ where: { AND: condiciones }, select: { id: true, name: true } })
  const orden = new Intl.Collator('es', { sensitivity: 'base', numeric: true })
  candidatos.sort((a, b) => orden.compare(a.name, b.name) || (a.id < b.id ? -1 : 1))
  const desde = input.cursor ? candidatos.findIndex((c) => c.id === input.cursor) + 1 : 0
  const idsPagina = candidatos.slice(desde, desde + input.limite).map((c) => c.id)
  const hayMas = desde + input.limite < candidatos.length
  const filasPorId = new Map((idsPagina.length === 0 ? [] : await db.supplier.findMany({ where: { id: { in: idsPagina } }, select: SELECCION })).map((f) => [f.id, f]))
  const pagina = idsPagina.map((id) => filasPorId.get(id)).filter((f): f is NonNullable<typeof f> => !!f)

  const abiertas = pagina.length === 0 ? [] : await db.accountPayable.findMany({
    where: { supplierId: { in: pagina.map((f) => f.id) }, status: 'ABIERTA' },
    select: { supplierId: true, amount: true, paidAmount: true, dueDate: true },
  })
  const items = pagina.map((f): FilaProveedor => {
    const r = resumenVencido(
      abiertas.filter((a) => a.supplierId === f.id).map((a) => ({ amount: num(a.amount), paidAmount: num(a.paidAmount), dueDate: a.dueDate.toISOString().slice(0, 10) })),
      hoy,
    )
    return {
      id: f.id, name: f.name, taxId: f.taxId, contact: f.contact, phone: f.phone, paymentTermDays: f.paymentTermDays, activo: f.deletedAt === null,
      deuda: num(f.payableBalance), vencido: r.vencido, cuentasVencidas: r.cuentas,
    }
  })
  return { items, siguiente: hayMas && pagina.length > 0 ? pagina[pagina.length - 1]!.id : null }
}

// ─── Ficha ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface CuentaPorPagarFicha {
  id: string; compra: string; monto: number; pagado: number; saldo: number; vence: string; vencida: boolean
}
export interface FichaProveedor {
  id: string; name: string; taxId: string | null; contact: string | null; phone: string | null; email: string | null
  address: string | null; notes: string | null; paymentTermDays: number; activo: boolean; creado: string
  /** El RUC se puede cambiar solo mientras no haya compras. */
  rucEditable: boolean
  deuda: number; vencido: number; cuentasVencidas: number
  comprasTotal: number
  /** Última compra RECIBIDA (ISO), o `null`. */
  ultimaCompra: string | null
  cuentasAbiertas: CuentaPorPagarFicha[]
}

export async function obtenerFichaProveedor(db: TenantPrismaClient, ctx: TenantContext, supplierId: string): Promise<FichaProveedor> {
  exigirVer(ctx)
  const s = await db.supplier.findFirst({ where: { id: supplierId }, select: SELECCION })
  if (!s) throw noExiste()
  if (s.deletedAt && !puede(ctx, 'proveedores.gestionar')) throw noExiste()

  const tenant = await db.tenant.findFirstOrThrow({ select: { timezone: true } })
  const hoy = hoyEnZona(tenant.timezone)
  const [abiertas, comprasTotal, ultima] = await Promise.all([
    db.accountPayable.findMany({
      where: { supplierId, status: 'ABIERTA' }, orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, amount: true, paidAmount: true, dueDate: true, purchase: { select: { number: true } } },
    }),
    db.purchase.count({ where: { supplierId } }),
    db.purchase.findFirst({ where: { supplierId, status: 'RECIBIDA' }, orderBy: { receivedAt: 'desc' }, select: { receivedAt: true } }),
  ])
  const cuentasAbiertas = abiertas.map((x): CuentaPorPagarFicha => {
    const vence = x.dueDate.toISOString().slice(0, 10)
    return {
      id: x.id, compra: x.purchase.number, monto: num(x.amount), pagado: num(x.paidAmount),
      saldo: Math.round((num(x.amount) - num(x.paidAmount)) * 100) / 100, vence, vencida: vence < hoy,
    }
  })
  const r = resumenVencido(cuentasAbiertas.map((x) => ({ amount: x.monto, paidAmount: x.pagado, dueDate: x.vence })), hoy)
  return {
    id: s.id, name: s.name, taxId: s.taxId, contact: s.contact, phone: s.phone, email: s.email, address: s.address, notes: s.notes,
    paymentTermDays: s.paymentTermDays, activo: s.deletedAt === null, creado: s.createdAt.toISOString(), rucEditable: comprasTotal === 0,
    deuda: num(s.payableBalance), vencido: r.vencido, cuentasVencidas: r.cuentas, comprasTotal,
    ultimaCompra: ultima?.receivedAt?.toISOString() ?? null, cuentasAbiertas,
  }
}
