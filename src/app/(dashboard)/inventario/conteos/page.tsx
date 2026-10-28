import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireTenantContext } from '@/lib/session'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { puede } from '@/lib/puede'
import { puedeVerConteos } from '@/features/inventory/conteo-service'
import { listarConteosConResponsables } from '@/features/inventory/conteo-lista'
import { ConteosLista } from '@/features/inventory/components/ConteosLista'
import { NuevoConteoForm } from '@/features/inventory/components/NuevoConteoForm'
import { ETIQUETA_ESTADO } from '@/features/inventory/conteo-ui'
import type { InventoryCountStatus } from '@/generated/prisma/enums'

export const dynamic = 'force-dynamic'

const ESTADOS = Object.keys(ETIQUETA_ESTADO) as InventoryCountStatus[]

/**
 * Tomas de inventario: las abiertas y las históricas. Verlas: `conteo.registrar`, `conteo.gestionar` o `stock.ajustar`. Crear una: `conteo.gestionar` (el servicio lo vuelve a
 * comprobar). Un conteo de una sucursal que la persona no alcanza no aparece (el cliente aislado lo filtra).
 */
export default async function ConteosPage({ searchParams }: { searchParams: Promise<{ estado?: string }> }) {
  const ctx = await requireTenantContext()
  if (!puedeVerConteos(ctx)) notFound()
  const db = getTenantPrisma(ctx)
  const { estado } = await searchParams
  const filtro = ESTADOS.find((e) => e === estado)
  const gestiona = puede(ctx, 'conteo.gestionar') && !ctx.operadorDe

  const [filas, tenant, almacenes, categorias] = await Promise.all([
    listarConteosConResponsables(db, ctx, { estado: filtro, limite: 100 }),
    db.tenant.findFirstOrThrow({ select: { timezone: true } }),
    gestiona ? db.warehouse.findMany({ where: { deletedAt: null, isActive: true, ...(ctx.branchIds ? { branchId: { in: [...ctx.branchIds] } } : {}) }, select: { id: true, name: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }] }) : [],
    gestiona ? db.category.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }] }) : [],
  ])

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-4 p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">Toma de inventario</h1>
          <p className="text-sm text-ink-muted">Cuenta lo que hay en el almacén, compáralo con el sistema y ajusta solo lo que se apruebe.</p>
        </div>
        <Link href="/inventario" className="text-sm font-semibold text-industrial-700 dark:text-industrial-300">← Inventario</Link>
      </header>

      <nav data-conteos="filtros" aria-label="Filtrar por estado" className="flex flex-wrap gap-2 text-sm font-semibold">
        <a href="/inventario/conteos" aria-current={!filtro ? 'page' : undefined} className={`rounded-full px-3 py-1 ${!filtro ? 'bg-industrial-600 text-white' : 'border border-hairline text-ink'}`}>Todas</a>
        {ESTADOS.map((e) => <a key={e} href={`/inventario/conteos?estado=${e}`} aria-current={filtro === e ? 'page' : undefined} className={`rounded-full px-3 py-1 ${filtro === e ? 'bg-industrial-600 text-white' : 'border border-hairline text-ink'}`}>{ETIQUETA_ESTADO[e]}</a>)}
      </nav>

      {gestiona && almacenes.length > 0 && <NuevoConteoForm almacenes={almacenes.map((a) => ({ id: a.id, nombre: a.name }))} categorias={categorias.map((c) => ({ id: c.id, nombre: c.name }))} />}
      <ConteosLista filas={filas} zona={tenant.timezone} />
    </main>
  )
}
