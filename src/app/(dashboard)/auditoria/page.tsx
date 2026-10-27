import { notFound } from 'next/navigation'
import { requireTenantContext } from '@/lib/session'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { puede } from '@/lib/puede'
import { isBusinessError } from '@/lib/errors'
import { CATEGORIAS } from '@/features/auditoria/catalogo'
import { parametrosAuditoriaSchema, type ParametrosAuditoria } from '@/features/auditoria/schemas'
import { listarAuditoria, personasParaFiltro } from '@/features/auditoria/service'
import { ListaAuditoria } from '@/features/auditoria/components/TablaAuditoria'
import { SelectorPeriodo } from '@/features/reportes/components/SelectorPeriodo'

export const dynamic = 'force-dynamic'

type Search = Promise<{ p?: string; desde?: string; hasta?: string; categoria?: string; actor?: string; entidad?: string; cursor?: string }>

const campo = 'h-touch rounded-xl border border-hairline bg-surface px-3 text-ink'

/**
 * Registro de auditoría: quién hizo qué y cuándo. Solo dueño y administrador (`auditoria.ver`); para el resto la página no existe (404).
 * Los filtros viajan por la dirección; una dirección manipulada vuelve a la última semana con un aviso, no a un error.
 */
export default async function AuditoriaPage({ searchParams }: { searchParams: Search }) {
  const ctx = await requireTenantContext()
  if (!puede(ctx, 'auditoria.ver')) notFound()
  const db = getTenantPrisma(ctx)
  const sp = await searchParams

  const porDefecto = parametrosAuditoriaSchema.parse({})
  const leidos = parametrosAuditoriaSchema.safeParse({
    p: sp.p || undefined, desde: sp.desde || undefined, hasta: sp.hasta || undefined, categoria: sp.categoria || undefined,
    actor: sp.actor || undefined, entidad: sp.entidad || undefined, cursor: sp.cursor || undefined,
  })
  let params: ParametrosAuditoria = leidos.success ? leidos.data : porDefecto
  let aviso: string | null = leidos.success ? null : 'Esa dirección tenía filtros que no entiendo: te muestro la última semana.'

  let informe
  try {
    informe = await listarAuditoria(db, ctx, params)
  } catch (e) {
    if (!(isBusinessError(e) && e.code === 'INVALID_DOCUMENT')) throw e
    aviso = e.message
    params = porDefecto
    informe = await listarAuditoria(db, ctx, params)
  }
  const personas = await personasParaFiltro(db, ctx)

  const extra = (
    <>
      <label className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">Tipo
        <select name="categoria" defaultValue={params.categoria} className={campo}>
          <option value="TODAS">Todos</option>
          {CATEGORIAS.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">Quién
        <select name="actor" defaultValue={params.actor ?? ''} className={campo}>
          <option value="">Cualquiera</option>
          {personas.map((u) => <option key={u.id} value={u.id}>{u.nombre}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">Sobre (código)
        <input type="text" name="entidad" maxLength={80} defaultValue={params.entidad ?? ''} placeholder="id del documento" className={`${campo} w-44`} />
      </label>
    </>
  )

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-4 p-4">
      <header>
        <h1 className="text-2xl font-bold text-ink">Auditoría</h1>
        <p className="text-sm text-ink-muted">Quién hizo qué y cuándo en todo tu negocio, en tu hora local. Solo lo ven el dueño y los administradores. Las contraseñas, claves y certificados nunca se muestran.</p>
      </header>
      <SelectorPeriodo tab="auditoria" pestanaInicial="auditoria" accion="/auditoria" params={params} extra={extra} />
      {aviso && <p role="alert" data-reporte="aviso" className="rounded-xl bg-stock-low-soft px-3 py-2 text-sm font-semibold text-stock-low">{aviso}</p>}
      <p data-periodo className="text-sm font-semibold text-ink">{informe.textoPeriodo}</p>
      <ListaAuditoria filas={informe.filas} zona={informe.zona} params={params} siguiente={informe.siguiente} />
    </main>
  )
}
