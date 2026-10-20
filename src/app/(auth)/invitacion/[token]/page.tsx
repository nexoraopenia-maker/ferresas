import { AceptarForm } from '@/features/usuarios/components/AceptarForm'

export const dynamic = 'force-dynamic'
// El token viaja en la URL: que ningún proxy ni referrer lo reenvíe.
export const metadata = { referrer: 'no-referrer', robots: { index: false } }

export default async function InvitacionPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 p-6">
      <header>
        <h1 className="text-3xl font-bold text-ink">Te invitaron a unirte</h1>
        <p className="mt-1 text-ink-muted">
          Elige tu nombre y una contraseña para entrar al equipo.
        </p>
      </header>
      <AceptarForm token={token} />
    </main>
  )
}
