import { logoutAction } from '../(auth)/actions'

export default function CuentaSuspendidaPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 p-6 text-center">
      <h1 className="text-2xl font-bold text-ink">Cuenta suspendida</h1>
      <p className="text-ink-muted">
        El acceso a esta cuenta está suspendido. Escríbenos para resolverlo.
      </p>
      <form action={logoutAction}>
        <button
          type="submit"
          className="h-touch-lg w-full rounded-2xl border border-hairline font-semibold text-ink"
        >
          Cerrar sesión
        </button>
      </form>
    </main>
  )
}
