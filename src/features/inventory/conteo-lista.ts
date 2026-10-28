import type { InventoryCountStatus } from '@/generated/prisma/enums'
import { BusinessError } from '@/lib/errors'
import type { TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { SELECCION_CONTEO, noExiste, puedeVerConteos, resumir, type ResumenConteo } from './conteo-service'

/** El listado y el detalle de los conteos CON sus responsables y fechas (F6.5c). Solo lectura; nada de lo que dice el sistema ni de costos. */

export interface FilaConteo extends ResumenConteo {
  creadoPor: string
  iniciadoPor: string | null
  cerradoPor: string | null
  aplicadoPor: string | null
  canceladoPor: string | null
  aplicadoEn: string | null
  canceladoEn: string | null
  motivoCancelacion: string | null
}

type Persona = { name: string | null; email: string } | null
const nombre = (p: Persona): string | null => (p ? p.name ?? p.email : null)

const SEL = {
  ...SELECCION_CONTEO,
  appliedAt: true, cancelledAt: true, cancelReason: true,
  createdBy: { select: { name: true, email: true } }, startedBy: { select: { name: true, email: true } }, closedBy: { select: { name: true, email: true } },
  appliedBy: { select: { name: true, email: true } }, cancelledBy: { select: { name: true, email: true } },
} as const

async function aFila(t: TenantPrismaClient, c: Awaited<ReturnType<TenantPrismaClient['inventoryCount']['findFirstOrThrow']>> & { createdBy: Persona; startedBy: Persona; closedBy: Persona; appliedBy: Persona; cancelledBy: Persona; appliedAt: Date | null; cancelledAt: Date | null; cancelReason: string | null; warehouse: { id: string; name: string } }): Promise<FilaConteo> {
  return {
    ...(await resumir(t, c as never)),
    creadoPor: nombre(c.createdBy) ?? '—', iniciadoPor: nombre(c.startedBy), cerradoPor: nombre(c.closedBy), aplicadoPor: nombre(c.appliedBy), canceladoPor: nombre(c.cancelledBy),
    aplicadoEn: c.appliedAt?.toISOString() ?? null, canceladoEn: c.cancelledAt?.toISOString() ?? null, motivoCancelacion: c.cancelReason,
  }
}

export async function listarConteosConResponsables(db: TenantPrismaClient, ctx: TenantContext, opts: { estado?: InventoryCountStatus; limite?: number } = {}): Promise<FilaConteo[]> {
  if (!puedeVerConteos(ctx)) throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para ver tomas de inventario.')
  const filas = await db.inventoryCount.findMany({ where: opts.estado ? { status: opts.estado } : {}, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: Math.min(opts.limite ?? 50, 200), select: SEL })
  return Promise.all(filas.map((c) => aFila(db, c as never)))
}

export interface DetalleConteo extends FilaConteo {
  /** Líneas mandadas a recontar (la pantalla de contar sigue abierta con el conteo en revisión). */
  porRecontar: number
  /** Líneas cuyo ajuste ya se aplicó al stock. */
  aplicadas: number
}

export async function detalleDeConteo(db: TenantPrismaClient, ctx: TenantContext, countId: string): Promise<DetalleConteo> {
  if (!puedeVerConteos(ctx)) throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para ver tomas de inventario.')
  const c = await db.inventoryCount.findFirst({ where: { id: countId }, select: SEL })
  if (!c) throw noExiste()
  const [porRecontar, aplicadas] = await Promise.all([
    db.inventoryCountItem.count({ where: { countId, status: 'RECONTAR' } }),
    db.inventoryCountItem.count({ where: { countId, resultingMovementId: { not: null } } }),
  ])
  return { ...(await aFila(db, c as never)), porRecontar, aplicadas }
}
