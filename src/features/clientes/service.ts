import { Prisma } from '@/generated/prisma/client'
import { BusinessError } from '@/lib/errors'
import { validarDocumento } from '@/lib/documentos'
import { P2002_UNIQUE } from '@/lib/prisma-errors'
import { exigir, puede } from '@/lib/puede'
import type { TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { bloquearCliente, hoyEnZona } from '@/features/credito/credito-service'
import { construirInfoCredito, resumenVencido, type InfoCreditoCliente } from '@/features/credito/reglas'
import { PERMISOS_VER_CLIENTES } from './permisos'
import { puedeVerClientes } from './permisos-ver'
import type { BajaClienteInput, CrearClienteInput, EditarClienteInput, ListarClientesInput, ReactivarClienteInput } from './schemas'

/**
 * Clientes: alta, edición, baja y consulta. Los datos de la persona; el DINERO (línea, deuda, abonos) es del módulo de crédito.
 *
 *  · Gestionar (crear, editar, dar de baja, reactivar): `clientes.gestionar` (dueño y administrador).
 *  · VER la lista y la ficha: además de lo anterior, quien cobra abonos o administra el crédito, para poder encontrar a quien paga.
 *  · El documento NO se puede cambiar si el cliente ya tiene ventas: cambiaría la identidad de comprobantes ya emitidos.
 *  · La baja es lógica (`deletedAt`) y se rechaza con deuda. Nunca se borra una fila.
 *
 * Todo cambio queda en el registro de auditoría con el antes y el después.
 */

const num = (d: { toString(): string } | null | undefined) => Number(d?.toString() ?? 0)
const noExiste = () => new BusinessError('NOT_FOUND', 'El cliente no existe.')
const invalido = (m: string) => new BusinessError('INVALID_DOCUMENT', m)

/** Bloquea al cliente. «No existe» es lo único que se traduce; un corte de conexión u otro fallo sigue siendo un fallo. */
async function bloquear(t: TenantPrismaClient, customerId: string) {
  try {
    return await bloquearCliente(t, customerId)
  } catch (e) {
    if (e instanceof BusinessError && e.code === 'TENANT_MISMATCH') throw noExiste()
    throw e
  }
}

export { PERMISOS_VER_CLIENTES }
export { puedeVerClientes }
function exigirVer(ctx: TenantContext): void {
  if (!puedeVerClientes(ctx)) throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para ver los clientes.')
}

/** Documento tecleado → tipo y número normalizados; sin documento, `SIN_DOCUMENTO`. Lanza si el documento no es válido. */
export function resolverDocumento(docNumber: string | undefined): { docType: 'DNI' | 'RUC' | 'SIN_DOCUMENTO'; docNumber: string | null } {
  if (!docNumber) return { docType: 'SIN_DOCUMENTO', docNumber: null }
  const v = validarDocumento(docNumber)
  if (!v.valido || !v.tipo) throw invalido(v.valido ? 'Documento no válido.' : v.mensaje)
  return { docType: v.tipo as 'DNI' | 'RUC', docNumber: docNumber.trim() }
}

const SELECCION = {
  id: true, name: true, docType: true, docNumber: true, phone: true, email: true, address: true, notes: true,
  creditLimit: true, creditBalance: true, creditTermDays: true, creditBlockedAt: true, isActive: true, deletedAt: true,
  createdAt: true, updatedAt: true, priceListId: true,
} as const

/** Los campos que un usuario edita, en el orden en que se auditan. */
const CAMPOS = ['name', 'docType', 'docNumber', 'phone', 'email', 'address', 'notes'] as const

// ─── Alta ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export async function crearCliente(db: TenantPrismaClient, ctx: TenantContext, input: CrearClienteInput): Promise<{ id: string; name: string }> {
  exigir(ctx, 'clientes.gestionar')
  const doc = resolverDocumento(input.docNumber)

  return db.$transaction(async (tx) => {
    const t = tx as unknown as TenantPrismaClient
    if (doc.docNumber) {
      const previo = await t.customer.findFirst({ where: { docType: doc.docType, docNumber: doc.docNumber }, select: { deletedAt: true } })
      if (previo) {
        throw new BusinessError('DUPLICATE_CODE', previo.deletedAt
          ? 'Ese documento pertenece a un cliente dado de baja: reactívalo desde Clientes en vez de crear otro.'
          : 'Ya existe un cliente con ese documento.')
      }
    }
    try {
      const c = await t.customer.create({
        data: {
          tenantId: ctx.tenantId, name: input.name, docType: doc.docType, docNumber: doc.docNumber,
          phone: input.phone ?? null, email: input.email ?? null, address: input.address ?? null, notes: input.notes ?? null,
        },
        select: { id: true, name: true },
      })
      await t.auditLog.create({
        data: {
          tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role, action: 'cliente.creado', entityType: 'Customer', entityId: c.id,
          after: { name: input.name, docType: doc.docType, docNumber: doc.docNumber }, impersonationId: ctx.impersonationId ?? null,
        },
      })
      return c
    } catch (e) {
      // Dos altas con el mismo documento a la vez: la restricción única de la base decide.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === P2002_UNIQUE) {
        throw new BusinessError('DUPLICATE_CODE', 'Ya existe un cliente con ese documento.')
      }
      throw e
    }
  }, { maxWait: 15_000, timeout: 30_000 })
}

// ─── Edición ────────────────────────────────────────────────────────────────────────────────────────────────────────

export async function editarCliente(db: TenantPrismaClient, ctx: TenantContext, input: EditarClienteInput): Promise<{ id: string; cambios: string[] }> {
  exigir(ctx, 'clientes.gestionar')
  const doc = resolverDocumento(input.docNumber)

  return db.$transaction(async (tx) => {
    const t = tx as unknown as TenantPrismaClient
    await bloquear(t, input.customerId)   // ← primero: nadie fía ni abona mientras se edita
    const antes = await t.customer.findFirst({ where: { id: input.customerId }, select: SELECCION })
    if (!antes) throw noExiste()
    if (antes.deletedAt) throw invalido('El cliente está dado de baja: reactívalo para editarlo.')

    const nuevo = {
      name: input.name, docType: doc.docType, docNumber: doc.docNumber,
      phone: input.phone ?? null, email: input.email ?? null, address: input.address ?? null, notes: input.notes ?? null,
    }
    const cambia = (k: (typeof CAMPOS)[number]) => (antes[k] ?? null) !== (nuevo[k] ?? null)
    const cambios = CAMPOS.filter(cambia)
    if (cambios.length === 0) return { id: antes.id, cambios: [] }

    if (cambia('docType') || cambia('docNumber')) {
      const ventas = await t.sale.count({ where: { customerId: antes.id } })
      if (ventas > 0) {
        throw invalido('El documento no se puede cambiar: el cliente ya tiene ventas y alteraría sus comprobantes. Crea otro cliente si es otra persona.')
      }
      if (doc.docNumber) {
        const otro = await t.customer.findFirst({ where: { docType: doc.docType, docNumber: doc.docNumber, id: { not: antes.id } }, select: { deletedAt: true } })
        if (otro) throw new BusinessError('DUPLICATE_CODE', otro.deletedAt ? 'Ese documento pertenece a un cliente dado de baja.' : 'Ya existe un cliente con ese documento.')
      } else if (num(antes.creditLimit) > 0 || num(antes.creditBalance) > 0) {
        throw invalido('No se puede quitar el documento a un cliente con línea de crédito o deuda: no se le podría fiar ni cobrar.')
      }
    }

    try {
      await t.customer.update({ where: { id: antes.id }, data: nuevo, select: { id: true } })
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === P2002_UNIQUE) {
        throw new BusinessError('DUPLICATE_CODE', 'Ya existe un cliente con ese documento.')
      }
      throw e
    }
    await t.auditLog.create({
      data: {
        tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role, action: 'cliente.editado', entityType: 'Customer', entityId: antes.id,
        before: Object.fromEntries(cambios.map((k) => [k, antes[k] ?? null])), after: Object.fromEntries(cambios.map((k) => [k, nuevo[k] ?? null])),
        impersonationId: ctx.impersonationId ?? null,
      },
    })
    return { id: antes.id, cambios }
  }, { maxWait: 15_000, timeout: 30_000 })
}

// ─── Baja y reactivación ────────────────────────────────────────────────────────────────────────────────────────────

export async function darDeBajaCliente(db: TenantPrismaClient, ctx: TenantContext, input: BajaClienteInput): Promise<{ id: string }> {
  exigir(ctx, 'clientes.gestionar')
  return db.$transaction(async (tx) => {
    const t = tx as unknown as TenantPrismaClient
    const c = await bloquear(t, input.customerId)   // ← una venta fiada en curso termina antes de decidir
    if (c.deletedAt) throw invalido('El cliente ya está dado de baja.')
    if (c.creditBalance > 0) {
      throw new BusinessError('CREDIT_BLOCKED', `El cliente debe S/ ${c.creditBalance.toFixed(2)}: cobra o castiga la deuda antes de darlo de baja.`, { deuda: c.creditBalance })
    }
    await t.customer.update({ where: { id: input.customerId }, data: { deletedAt: new Date(), isActive: false }, select: { id: true } })
    await t.auditLog.create({
      data: {
        tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role, action: 'cliente.baja', entityType: 'Customer', entityId: input.customerId,
        reason: input.motivo, before: { name: c.name }, impersonationId: ctx.impersonationId ?? null,
      },
    })
    return { id: input.customerId }
  }, { maxWait: 15_000, timeout: 30_000 })
}

export async function reactivarCliente(db: TenantPrismaClient, ctx: TenantContext, input: ReactivarClienteInput): Promise<{ id: string }> {
  exigir(ctx, 'clientes.gestionar')
  return db.$transaction(async (tx) => {
    const t = tx as unknown as TenantPrismaClient
    const c = await bloquear(t, input.customerId)
    if (!c.deletedAt) throw invalido('El cliente ya está activo.')
    await t.customer.update({ where: { id: input.customerId }, data: { deletedAt: null, isActive: true }, select: { id: true } })
    await t.auditLog.create({
      data: {
        tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role, action: 'cliente.reactivado', entityType: 'Customer', entityId: input.customerId,
        after: { name: c.name }, impersonationId: ctx.impersonationId ?? null,
      },
    })
    return { id: input.customerId }
  }, { maxWait: 15_000, timeout: 30_000 })
}

// ─── Lista ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface FilaCliente {
  id: string; name: string; docType: string; docNumber: string | null; phone: string | null
  limite: number; deuda: number; disponible: number; bloqueado: boolean; activo: boolean
  /** Saldo de cuentas ya vencidas y cuántas. */
  vencido: number; cuentasVencidas: number
}
export interface PaginaClientes { items: FilaCliente[]; siguiente: string | null }

export async function listarClientes(db: TenantPrismaClient, ctx: TenantContext, input: ListarClientesInput): Promise<PaginaClientes> {
  exigirVer(ctx)
  if (input.filtro === 'DE_BAJA' && !puede(ctx, 'clientes.gestionar')) {
    throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para ver los clientes dados de baja.')
  }
  const tenant = await db.tenant.findFirstOrThrow({ select: { timezone: true } })
  const hoy = hoyEnZona(tenant.timezone)
  const hoyFecha = new Date(`${hoy}T00:00:00.000Z`)

  const sinDocumento: Prisma.CustomerWhereInput = { OR: [{ docType: 'SIN_DOCUMENTO' }, { docNumber: null }] }
  const condiciones: Prisma.CustomerWhereInput[] = [{ deletedAt: input.filtro === 'DE_BAJA' ? { not: null } : null }]
  if (input.q) condiciones.push({ OR: [{ name: { contains: input.q, mode: 'insensitive' } }, { docNumber: { contains: input.q } }, { phone: { contains: input.q } }] })
  if (input.filtro === 'CON_DEUDA') condiciones.push({ creditBalance: { gt: 0 } })
  if (input.filtro === 'BLOQUEADOS') condiciones.push({ creditBlockedAt: { not: null } })
  if (input.filtro === 'SIN_DOCUMENTO') condiciones.push(sinDocumento)
  if (input.filtro === 'VENCIDOS') condiciones.push({ receivables: { some: { status: 'ABIERTA', dueDate: { lt: hoyFecha } } } })
  const final: Prisma.CustomerWhereInput = { AND: condiciones }

  /*
   * El orden alfabético lo hace la aplicación, no la base: Postgres ordena por bytes y mandaría «Álvaro», «Ángel» o «Ñusta» detrás de
   * la «Z». Se leen solo id y nombre de lo que coincide (barato), se ordenan con el criterio del español y de ahí se corta la página;
   * el cursor es la posición del último id. Para el tamaño de una ferretería es de sobra; solo la página pide los datos completos.
   */
  const candidatos = await db.customer.findMany({ where: final, select: { id: true, name: true } })
  const orden = new Intl.Collator('es', { sensitivity: 'base', numeric: true })
  candidatos.sort((a, b) => orden.compare(a.name, b.name) || (a.id < b.id ? -1 : 1))
  const desde = input.cursor ? candidatos.findIndex((c) => c.id === input.cursor) + 1 : 0
  const idsPagina = candidatos.slice(desde, desde + input.limite).map((c) => c.id)
  const hayMas = desde + input.limite < candidatos.length
  const filasPorId = new Map((idsPagina.length === 0 ? [] : await db.customer.findMany({ where: { id: { in: idsPagina } }, select: SELECCION })).map((f) => [f.id, f]))
  const pagina = idsPagina.map((id) => filasPorId.get(id)).filter((f): f is NonNullable<typeof f> => !!f)

  const abiertas = pagina.length === 0 ? [] : await db.receivable.findMany({
    where: { customerId: { in: pagina.map((f) => f.id) }, status: 'ABIERTA' },
    select: { customerId: true, amount: true, paidAmount: true, dueDate: true },
  })
  const items = pagina.map((f): FilaCliente => {
    const r = resumenVencido(
      abiertas.filter((a) => a.customerId === f.id).map((a) => ({ amount: num(a.amount), paidAmount: num(a.paidAmount), dueDate: a.dueDate.toISOString().slice(0, 10) })),
      hoy,
    )
    const limite = num(f.creditLimit), deuda = num(f.creditBalance)
    return {
      id: f.id, name: f.name, docType: f.docType, docNumber: f.docNumber, phone: f.phone,
      limite, deuda, disponible: Math.max(0, Math.round((limite - deuda) * 100) / 100),
      bloqueado: f.creditBlockedAt !== null, activo: f.deletedAt === null, vencido: r.vencido, cuentasVencidas: r.cuentas,
    }
  })
  return { items, siguiente: hayMas && pagina.length > 0 ? pagina[pagina.length - 1]!.id : null }
}

// ─── Ficha ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface CuentaFicha {
  id: string; venta: string; fecha: string; monto: number; abonado: number; saldo: number
  vence: string; status: 'ABIERTA' | 'PAGADA' | 'ANULADA'; vencida: boolean; enRevision: boolean; motivoRevision: string | null
}
export interface AbonoFicha {
  id: string; fecha: string; metodo: string; monto: number; referencia: string | null; cobradoPor: string
  anulado: boolean; motivoAnulacion: string | null; cuentasPagadas: number
}
export interface FichaCliente {
  id: string; name: string; docType: string; docNumber: string | null; phone: string | null; email: string | null
  address: string | null; notes: string | null; activo: boolean; creado: string
  /** Lista de precios por defecto (F6.7); `null` = Base. */
  priceListId: string | null
  /** El documento se puede cambiar solo mientras no haya ventas. */
  documentoEditable: boolean
  credito: InfoCreditoCliente
  cuentasAbiertas: CuentaFicha[]
  cuentasCerradas: CuentaFicha[]
  abonos: AbonoFicha[]
}

export async function obtenerFichaCliente(db: TenantPrismaClient, ctx: TenantContext, customerId: string): Promise<FichaCliente> {
  exigirVer(ctx)
  const c = await db.customer.findFirst({ where: { id: customerId }, select: SELECCION })
  if (!c) throw noExiste()
  if (c.deletedAt && !puede(ctx, 'clientes.gestionar')) throw noExiste()

  const tenant = await db.tenant.findFirstOrThrow({ select: { timezone: true } })
  const hoy = hoyEnZona(tenant.timezone)
  const selCuenta = {
    id: true, amount: true, paidAmount: true, dueDate: true, status: true, createdAt: true, reviewRequestedAt: true, reviewReason: true,
    sale: { select: { number: true } },
  } as const
  const [abiertas, cerradas, abonos, ventas] = await Promise.all([
    db.receivable.findMany({ where: { customerId, status: 'ABIERTA' }, orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }], select: selCuenta }),
    db.receivable.findMany({ where: { customerId, status: { not: 'ABIERTA' } }, orderBy: { createdAt: 'desc' }, take: 30, select: selCuenta }),
    db.customerPayment.findMany({
      where: { customerId }, orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }], take: 50,
      select: {
        id: true, receivedAt: true, method: true, amount: true, reference: true, voidedAt: true, voidReason: true,
        user: { select: { name: true } }, allocations: { select: { id: true } },
      },
    }),
    db.sale.count({ where: { customerId } }),
  ])
  const aCuenta = (x: (typeof abiertas)[number]): CuentaFicha => {
    const vence = x.dueDate.toISOString().slice(0, 10)
    const saldo = Math.round((num(x.amount) - num(x.paidAmount)) * 100) / 100
    return {
      id: x.id, venta: x.sale.number, fecha: x.createdAt.toISOString(), monto: num(x.amount), abonado: num(x.paidAmount), saldo,
      vence, status: x.status, vencida: x.status === 'ABIERTA' && vence < hoy, enRevision: x.reviewRequestedAt !== null, motivoRevision: x.reviewReason,
    }
  }
  const cuentasAbiertas = abiertas.map(aCuenta)
  return {
    id: c.id, name: c.name, docType: c.docType, docNumber: c.docNumber, phone: c.phone, email: c.email, address: c.address, notes: c.notes,
    activo: c.deletedAt === null, creado: c.createdAt.toISOString(), priceListId: c.priceListId, documentoEditable: ventas === 0,
    credito: construirInfoCredito(
      c.id,
      { name: c.name, docType: c.docType, docNumber: c.docNumber, isActive: c.isActive, deletedAt: c.deletedAt, creditLimit: num(c.creditLimit), creditBalance: num(c.creditBalance), creditBlockedAt: c.creditBlockedAt, creditTermDays: c.creditTermDays },
      cuentasAbiertas.map((x) => ({ amount: x.monto, paidAmount: x.abonado, dueDate: x.vence })),
      hoy,
    ),
    cuentasAbiertas,
    cuentasCerradas: cerradas.map(aCuenta),
    abonos: abonos.map((a): AbonoFicha => ({
      id: a.id, fecha: a.receivedAt.toISOString(), metodo: a.method, monto: num(a.amount), referencia: a.reference, cobradoPor: a.user.name,
      anulado: a.voidedAt !== null, motivoAnulacion: a.voidReason, cuentasPagadas: a.allocations.length,
    })),
  }
}
