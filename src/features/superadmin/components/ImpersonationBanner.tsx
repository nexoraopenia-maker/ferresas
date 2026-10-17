import { cookies } from 'next/headers'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { resolveImpersonation } from '@/lib/impersonation'
import { SUPPORT_COOKIE, verificarSupportToken } from '@/lib/support-token'

/**
 * Aviso de impersonation (§5.3: "estás viendo como Ferretería X").
 *
 * Se pinta por encima de todo y en un color que no se usa en ninguna otra
 * parte de la app. La razón es concreta: el fallo peligroso no es entrar en la
 * cuenta de un cliente, es OLVIDAR que se está dentro y creer que se mira la
 * propia. Por eso también se muestra el tiempo que queda.
 */
export async function ImpersonationBanner() {
  const session = await auth()
  if (!session?.user?.id) return null

  // El token firmado lleva la caducidad dentro; si ya venció, no hay banner
  // que pintar y tampoco hace falta consultar la base.
  const id = verificarSupportToken((await cookies()).get(SUPPORT_COOKIE)?.value)?.id
  const imp = await resolveImpersonation(session.user.id, id)
  if (!imp) return null

  const [tenant, fila] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: imp.tenantId }, select: { name: true } }),
    prisma.impersonationSession.findUnique({
      where: { id: imp.id },
      select: { expiresAt: true, reason: true },
    }),
  ])

  const minutos = fila
    ? Math.max(Math.ceil((fila.expiresAt.getTime() - Date.now()) / 60_000), 0)
    : 0

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 bg-graphite-900 px-4 py-3 text-graphite-50">
      <div className="min-w-0">
        <p className="text-sm font-bold">
          Modo soporte · estás viendo como{' '}
          <span className="text-industrial-400">{tenant?.name ?? 'esta cuenta'}</span>
        </p>
        <p className="text-xs text-graphite-300">
          Solo lectura · quedan {minutos} min · todo queda auditado
        </p>
      </div>
      <form action="/salir-de-soporte" method="post">
        <button
          type="submit"
          className="h-touch rounded-xl bg-industrial-600 px-4 text-sm font-bold text-white"
        >
          Salir del modo soporte
        </button>
      </form>
    </div>
  )
}
