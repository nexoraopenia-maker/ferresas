import { LoginForm } from './LoginForm'

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string }>
}) {
  const { callbackUrl } = await searchParams

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-8 p-6">
      <header>
        <h1 className="text-3xl font-bold text-ink">FerreSaaS</h1>
        <p className="mt-1 text-ink-muted">Entra para gestionar tu inventario.</p>
      </header>
      {/* Solo se acepta una ruta relativa: un callbackUrl absoluto sería un
          open redirect hacia cualquier dominio. */}
      <LoginForm callbackUrl={callbackUrl?.startsWith('/') ? callbackUrl : undefined} />
    </main>
  )
}
