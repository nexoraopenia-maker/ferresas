import { notFound } from 'next/navigation'
import { requireTenantContext } from '@/lib/session'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { puede } from '@/lib/puede'
import { rolesAsignables } from '@/features/usuarios/asignacion'
import { listarEquipo } from '@/features/usuarios/service'
import { EquipoManager } from '@/features/usuarios/components/EquipoManager'

export const dynamic = 'force-dynamic'

/** Equipo del negocio: quién entra, con qué rol y a qué sucursales. */
export default async function UsuariosPage() {
  const ctx = await requireTenantContext()
  if (!puede(ctx, 'usuarios.gestionar')) notFound()

  const db = getTenantPrisma(ctx)
  const [equipo, sucursales] = await Promise.all([
    listarEquipo(db, ctx),
    db.branch.findMany({
      where: { id: { in: [...(ctx.branchIds ?? [])] }, isActive: true, deletedAt: null },
      orderBy: { code: 'asc' },
      select: { id: true, name: true },
    }),
  ])
  const puedeOperar = ctx.access === 'FULL' || ctx.access === 'WARN'

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-5 p-4">
      <header>
        <h1 className="text-2xl font-bold text-ink">Equipo</h1>
        <p className="text-sm text-ink-muted">
          Invita a tu gente y elige qué puede hacer cada uno. Solo puedes dar roles
          que no tengan más poder que el tuyo.
        </p>
      </header>
      <EquipoManager
        yo={ctx.userId}
        rolesAsignables={rolesAsignables(ctx)}
        sucursales={sucursales}
        puedeOperar={puedeOperar}
        miembros={equipo.miembros.map((m) => ({ ...m, lastLoginAt: m.lastLoginAt?.toISOString() ?? null }))}
        invitaciones={equipo.invitaciones.map((i) => ({ ...i, expiresAt: i.expiresAt.toISOString() }))}
      />
    </main>
  )
}
