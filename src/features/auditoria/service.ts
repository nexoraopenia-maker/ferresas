import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import type { TenantContext } from '@/lib/tenant-context'
import { exigir } from '@/lib/puede'
import { BusinessError } from '@/lib/errors'
import { describirPeriodo, resolverPeriodo, type PeriodoElegido } from '@/features/reportes/periodo'
import { accionesDe, CODIGOS_CONOCIDOS, describirAccion, type Categoria } from './catalogo'
import { mostrarJson } from './redaccion'
import { TAMANO_PAGINA, type ParametrosAuditoria } from './schemas'

/**
 * El registro de auditoría en pantalla. SOLO LECTURA, y solo para quien tenga `auditoria.ver` (dueño y administrador).
 *
 * · Tenant: el cliente aislado acota por negocio; las filas sin negocio (acciones globales del dueño del SaaS) nunca aparecen.
 * · Sucursal: el registro NO tiene sucursal, así que no se acota por ella: quien lo ve, ve el de todo el negocio. Es el alcance de
 *   dueño y administrador (el administrador ya gestiona usuarios de todo el negocio); está documentado en ARCHITECTURE.md.
 * · Antes y después pasan por `mostrarJson` (se tapan secretos) ANTES de salir de este módulo: la pantalla nunca recibe el crudo.
 * · Orden: más reciente primero, con desempate por id; paginación por cursor (instante|id), estable aunque entren registros nuevos.
 */

export interface FilaAuditoria {
  id: string
  /** ISO. */
  cuando: string
  accion: string
  etiqueta: string
  categoria: Categoria
  /** Nombre; si el usuario ya no existe, el correo congelado; si fue el sistema, «Sistema». */
  actor: string
  rol: string | null
  entidad: string | null
  motivo: string | null
  antes: { texto: string; truncado: boolean } | null
  despues: { texto: string; truncado: boolean } | null
  ip: string | null
  /** Se hizo durante una sesión de soporte. */
  soporte: boolean
}

export interface InformeAuditoria { textoPeriodo: string; zona: string; filas: FilaAuditoria[]; siguiente: string | null }

const exigirAuditoria = (ctx: TenantContext) => exigir(ctx, 'auditoria.ver')

export async function listarAuditoria(db: TenantPrismaClient, ctx: TenantContext, p: ParametrosAuditoria, ahora: Date = new Date()): Promise<InformeAuditoria> {
  exigirAuditoria(ctx)
  const t = await db.tenant.findFirstOrThrow({ select: { timezone: true } })
  let periodo: PeriodoElegido
  try {
    periodo = resolverPeriodo({ preset: p.p, desde: p.desde, hasta: p.hasta }, ahora, t.timezone)
  } catch (e) {
    if (e instanceof RangeError) throw new BusinessError('INVALID_DOCUMENT', e.message)
    throw e
  }
  const y: object[] = [{ createdAt: { gte: periodo.desde, lt: periodo.hasta } }]
  if (p.categoria !== 'TODAS') y.push(p.categoria === 'Otros' ? { action: { notIn: [...CODIGOS_CONOCIDOS] } } : { action: { in: accionesDe(p.categoria) } })
  if (p.actor) y.push({ actorId: p.actor })
  if (p.entidad) y.push({ entityId: p.entidad })
  if (p.cursor) {
    const [iso, id] = p.cursor.split('|') as [string, string]
    const c = new Date(iso)
    y.push({ OR: [{ createdAt: { lt: c } }, { createdAt: c, id: { lt: id } }] })
  }
  const filas = await db.auditLog.findMany({
    where: { AND: y },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: TAMANO_PAGINA + 1,
    select: {
      id: true, createdAt: true, action: true, entityType: true, entityId: true, reason: true, before: true, after: true,
      actorRole: true, actorEmail: true, ipAddress: true, impersonationId: true, actor: { select: { name: true } },
    },
  })
  const hayMas = filas.length > TAMANO_PAGINA
  const visibles = filas.slice(0, TAMANO_PAGINA)
  const ultimo = visibles[visibles.length - 1]
  return {
    textoPeriodo: describirPeriodo(periodo), zona: t.timezone,
    siguiente: hayMas && ultimo ? `${ultimo.createdAt.toISOString()}|${ultimo.id}` : null,
    filas: visibles.map((r): FilaAuditoria => {
      const d = describirAccion(r.action)
      return {
        id: r.id, cuando: r.createdAt.toISOString(), accion: r.action, etiqueta: d.etiqueta, categoria: d.categoria,
        actor: r.actor?.name || r.actorEmail || 'Sistema', rol: r.actorRole ?? null,
        entidad: r.entityType || r.entityId ? [r.entityType, r.entityId].filter(Boolean).join(' ') : null,
        motivo: r.reason ?? null, antes: mostrarJson(r.before), despues: mostrarJson(r.after), ip: r.ipAddress ?? null, soporte: r.impersonationId !== null,
      }
    }),
  }
}

/** Las personas del negocio, para el filtro «Quién». */
export async function personasParaFiltro(db: TenantPrismaClient, ctx: TenantContext): Promise<{ id: string; nombre: string }[]> {
  exigirAuditoria(ctx)
  const us = await db.user.findMany({ select: { id: true, name: true, email: true }, orderBy: { name: 'asc' }, take: 300 })
  return us.map((u) => ({ id: u.id, nombre: u.name || u.email }))
}
