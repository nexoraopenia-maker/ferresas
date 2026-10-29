/**
 * Las cajas (puestos de cobro) de una sucursal (F6.8a): crear, renombrar y dar de baja. Todo lo que escribe exige `caja.administrar` (fuera del PIN), es todo o nada y deja una fila de
 * auditoría. Este servicio NO abre ni cierra turnos ni toca ninguna operación de dinero (eso es F6.8b): solo administra las cajas.
 *
 * Reglas: hasta 5 cajas VIVAS por sucursal (se comprueba bloqueando la fila de la sucursal, así que dos administradores creando la sexta a la vez no la consiguen los dos); el nombre es único
 * sin distinguir mayúsculas entre las vivas (lo garantiza el índice parcial de la migración); una sucursal conserva SIEMPRE al menos una caja viva; una caja con un turno abierto no se da de
 * baja; la baja es lógica (una caja con turnos no se borra) y libera su nombre.
 */
import { Prisma } from '@/generated/prisma/client'
import { BusinessError } from '@/lib/errors'
import { exigir } from '@/lib/puede'
import type { TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import {
  MAX_CAJAS_POR_SUCURSAL, NOMBRE_CAJA_PRINCIPAL, crearCajaSchema, darDeBajaCajaSchema, renombrarCajaSchema,
  type CrearCajaInput, type DarDeBajaCajaInput, type RenombrarCajaInput,
} from './cajas-schemas'

const invalido = (m: string) => new BusinessError('INVALID_DOCUMENT', m)
const noExiste = () => new BusinessError('NOT_FOUND', 'La caja no existe.')
const OPCIONES_TX = { maxWait: 15_000, timeout: 60_000 } as const
const P2002 = 'P2002'

async function auditar(t: TenantPrismaClient, ctx: TenantContext, e: { action: string; entityId: string; before?: object; after?: object }) {
  await t.auditLog.create({
    data: {
      tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role, action: e.action, entityType: 'CashRegister', entityId: e.entityId,
      ...(e.before ? { before: e.before as never } : {}), ...(e.after ? { after: e.after as never } : {}), impersonationId: ctx.impersonationId ?? null,
    },
  })
}

const duplicado = (e: unknown): never => {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === P2002) throw new BusinessError('DUPLICATE_CODE', 'Ya hay una caja con ese nombre en esta sucursal.')
  throw e
}

/** ¿Alcanza la persona esta sucursal? Sin `branchIds` en el contexto (dueño de todo) alcanza todas. */
const alcanza = (ctx: TenantContext, branchId: string) => !ctx.branchIds || ctx.branchIds.includes(branchId)

export interface CajaDeSucursal {
  id: string
  branchId: string
  name: string
  /** El turno abierto en esta caja, si lo hay: quién y desde cuándo. */
  turnoAbierto: { id: string; abiertoPor: string; desde: string } | null
}

/**
 * Las cajas vivas de una sucursal con quién las tiene abiertas. Sin permiso aparte: quien abre un turno necesita ver qué cajas hay y cuáles están ocupadas (solo el nombre de quien la
 * tiene; ninguna cifra). Una sucursal que la persona no alcanza devuelve vacío.
 */
export async function cajasDeSucursal(db: TenantPrismaClient, ctx: TenantContext, branchId: string): Promise<CajaDeSucursal[]> {
  if (!alcanza(ctx, branchId)) return []
  const cajas = await db.cashRegister.findMany({
    where: { branchId, deletedAt: null, isActive: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, branchId: true, name: true, sessions: { where: { status: 'ABIERTA' }, take: 1, select: { id: true, openedAt: true, openedBy: { select: { name: true } } } } },
  })
  return cajas.map((c) => ({
    id: c.id, branchId: c.branchId, name: c.name,
    turnoAbierto: c.sessions[0] ? { id: c.sessions[0].id, abiertoPor: c.sessions[0].openedBy.name, desde: c.sessions[0].openedAt.toISOString() } : null,
  }))
}

/** Las cajas de una sucursal para administrarlas. Exige `caja.administrar`. */
export async function listarCajas(db: TenantPrismaClient, ctx: TenantContext, branchId: string): Promise<CajaDeSucursal[]> {
  exigir(ctx, 'caja.administrar')
  return cajasDeSucursal(db, ctx, branchId)
}

/**
 * Crea la «Caja principal» de una sucursal si aún no tiene ninguna caja. La usa el alta de sucursales (F6.8b): una sucursal sin cajas no podría abrir turno. Determinista e idempotente
 * (mismo id para la misma sucursal): llamarla dos veces no crea dos. Sin permisos: la ejecuta el servicio que crea la sucursal.
 */
export async function asegurarCajaPrincipal(t: TenantPrismaClient, tenantId: string, branchId: string): Promise<string> {
  const existente = await t.cashRegister.findFirst({ where: { branchId, deletedAt: null }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true } })
  if (existente) return existente.id
  const c = await t.cashRegister.create({ data: { tenantId, branchId, name: NOMBRE_CAJA_PRINCIPAL }, select: { id: true } })
  return c.id
}

export async function crearCaja(db: TenantPrismaClient, ctx: TenantContext, entrada: CrearCajaInput): Promise<{ id: string; name: string }> {
  exigir(ctx, 'caja.administrar')
  const p = crearCajaSchema.safeParse(entrada)
  if (!p.success) throw invalido(p.error.issues[0]?.message ?? 'Revisa los datos.')
  if (!alcanza(ctx, p.data.branchId)) throw new BusinessError('NOT_FOUND', 'La sucursal no existe o no es de las tuyas.')

  try {
    return await db.$transaction(async (tx) => {
      const t = tx as unknown as TenantPrismaClient
      // Se BLOQUEA la sucursal antes de contar: dos administradores creando la sexta caja a la vez se serializan y el segundo ve el tope.
      try {
        await t.branch.update({ where: { id: p.data.branchId }, data: { updatedAt: new Date() }, select: { id: true } })
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') throw new BusinessError('NOT_FOUND', 'La sucursal no existe o no es de las tuyas.')
        throw e
      }
      const sucursal = await t.branch.findFirst({ where: { id: p.data.branchId, deletedAt: null }, select: { id: true, name: true } })
      if (!sucursal) throw new BusinessError('NOT_FOUND', 'La sucursal no existe o no es de las tuyas.')
      const vivas = await t.cashRegister.count({ where: { branchId: sucursal.id, deletedAt: null } })
      if (vivas >= MAX_CAJAS_POR_SUCURSAL) throw invalido(`Una sucursal admite hasta ${MAX_CAJAS_POR_SUCURSAL} cajas. Da de baja alguna para crear otra.`)
      const c = await t.cashRegister.create({ data: { tenantId: ctx.tenantId, branchId: sucursal.id, name: p.data.name }, select: { id: true, name: true } })
      await auditar(t, ctx, { action: 'caja.creada', entityId: c.id, after: { nombre: c.name, sucursal: sucursal.name } })
      return c
    }, OPCIONES_TX)
  } catch (e) { return duplicado(e) }
}

export async function renombrarCaja(db: TenantPrismaClient, ctx: TenantContext, entrada: RenombrarCajaInput): Promise<{ id: string }> {
  exigir(ctx, 'caja.administrar')
  const p = renombrarCajaSchema.safeParse(entrada)
  if (!p.success) throw invalido(p.error.issues[0]?.message ?? 'Revisa los datos.')
  try {
    return await db.$transaction(async (tx) => {
      const t = tx as unknown as TenantPrismaClient
      const antes = await t.cashRegister.findFirst({ where: { id: p.data.registerId, deletedAt: null }, select: { id: true, name: true, branchId: true } })
      if (!antes || !alcanza(ctx, antes.branchId)) throw noExiste()
      if (antes.name === p.data.name) return { id: antes.id }
      await t.cashRegister.update({ where: { id: antes.id }, data: { name: p.data.name }, select: { id: true } })
      await auditar(t, ctx, { action: 'caja.renombrada', entityId: antes.id, before: { nombre: antes.name }, after: { nombre: p.data.name } })
      return { id: antes.id }
    }, OPCIONES_TX)
  } catch (e) { return duplicado(e) }
}

export async function darDeBajaCaja(db: TenantPrismaClient, ctx: TenantContext, entrada: DarDeBajaCajaInput): Promise<{ id: string }> {
  exigir(ctx, 'caja.administrar')
  const p = darDeBajaCajaSchema.safeParse(entrada)
  if (!p.success) throw invalido(p.error.issues[0]?.message ?? 'Revisa los datos.')
  return db.$transaction(async (tx) => {
    const t = tx as unknown as TenantPrismaClient
    const caja = await t.cashRegister.findFirst({ where: { id: p.data.registerId, deletedAt: null }, select: { id: true, name: true, branchId: true } })
    if (!caja || !alcanza(ctx, caja.branchId)) throw noExiste()
    // Se bloquea la sucursal (como al crear) y la caja antes de mirar: no se puede quedar sin cajas ni dar de baja una que alguien está abriendo en este instante.
    await t.branch.update({ where: { id: caja.branchId }, data: { updatedAt: new Date() }, select: { id: true } })
    await t.cashRegister.update({ where: { id: caja.id }, data: { updatedAt: new Date() }, select: { id: true } })
    const vivas = await t.cashRegister.count({ where: { branchId: caja.branchId, deletedAt: null } })
    if (vivas <= 1) throw invalido('Una sucursal necesita al menos una caja. Crea otra antes de dar de baja ésta.')
    const abierto = await t.cashSession.findFirst({ where: { registerId: caja.id, status: 'ABIERTA' }, select: { id: true, openedBy: { select: { name: true } } } })
    if (abierto) throw invalido(`La caja «${caja.name}» tiene un turno abierto (de ${abierto.openedBy.name}). Ciérralo antes de darla de baja.`)
    await t.cashRegister.update({ where: { id: caja.id }, data: { isActive: false, deletedAt: new Date() }, select: { id: true } })
    await auditar(t, ctx, { action: 'caja.baja', entityId: caja.id, before: { nombre: caja.name } })
    return { id: caja.id }
  }, OPCIONES_TX)
}
