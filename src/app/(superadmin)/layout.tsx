import { notFound } from 'next/navigation'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

/**
 * Segunda capa del guard del Panel Maestro (§5.3).
 *
 * El proxy ya responde 404 a quien no es SUPERADMIN, pero esta comprobación
 * no sobra: si algún día alguien toca el `matcher` del proxy y deja fuera
 * esta ruta, el panel quedaría abierto sin que nada avisara. Aquí el guard
 * viaja pegado al código que protege.
 *
 * Se usa `notFound()` y no un redirect, por lo mismo que en el proxy: la
 * respuesta debe ser indistinguible de una ruta que no existe.
 *
 * Ojo: se lee el rol REAL de la sesión de NextAuth, ignorando cualquier
 * impersonation. Un superadmin que esté dando soporte sigue siendo superadmin
 * y debe poder volver a su panel.
 */
export const dynamic = 'force-dynamic'

export default async function SuperAdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await auth()
  if (!session?.user?.id) notFound()

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { role: true, isActive: true, deletedAt: true },
  })

  if (!user || user.role !== 'SUPERADMIN' || !user.isActive || user.deletedAt) {
    notFound()
  }

  return <div className="min-h-dvh bg-surface-sunken">{children}</div>
}
