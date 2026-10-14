'use client'

import { useState, useTransition } from 'react'

/**
 * Cambio de contraseña del Super Admin.
 *
 * Avisa ANTES de ejecutar que cerrará todas las sesiones, incluida la actual.
 * Es consecuencia de cómo está implementada la revocación (ver
 * User.passwordChangedAt) y, sobre todo, es lo que uno quiere: si cambias la
 * contraseña porque sospechas que te la robaron, no sirve de nada que la
 * sesión del intruso siga viva.
 */
export function ChangePasswordModal() {
  const [abierto, setAbierto] = useState(false)
  const [actual, setActual] = useState('')
  const [nueva, setNueva] = useState('')
  const [confirmar, setConfirmar] = useState('')
  const [ver, setVer] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [campos, setCampos] = useState<Record<string, string[]>>({})
  const [listo, setListo] = useState(false)
  const [pending, startTransition] = useTransition()

  const cerrar = () => {
    setAbierto(false)
    setActual(''); setNueva(''); setConfirmar('')
    setError(null); setCampos({}); setVer(false)
  }

  const enviar = () => {
    setError(null)
    setCampos({})
    startTransition(async () => {
      const res = await fetch('/api/account/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          currentPassword: actual,
          newPassword: nueva,
          confirmPassword: confirmar,
        }),
      })

      if (res.status === 429) {
        setError('Demasiados intentos. Espera unos minutos.')
        return
      }
      if (res.status === 404) {
        setError('Tu sesión expiró. Recarga la página.')
        return
      }

      const datos = await res.json().catch(() => null)
      if (!res.ok) {
        if (datos?.fields) setCampos(datos.fields)
        setError(datos?.message ?? 'No se pudo cambiar la contraseña.')
        return
      }

      // No se redirige solo: el aviso tiene que verse. La sesión ya está
      // revocada, así que la siguiente navegación llevará al login igualmente.
      setListo(true)
      setActual(''); setNueva(''); setConfirmar('')
    })
  }

  const err = (c: string) => campos[c]?.[0]
  const fuerza = nueva.length === 0 ? null : nueva.length < 12 ? 'corta' : nueva.length < 16 ? 'aceptable' : 'buena'

  return (
    <>
      <button
        type="button"
        onClick={() => { setListo(false); setAbierto(true) }}
        className="h-touch rounded-xl border border-hairline px-4 text-sm font-semibold text-ink"
      >
        Cambiar mi contraseña
      </button>

      {listo && (
        <div className="fixed inset-0 z-50 grid place-items-center p-4">
          <div className="absolute inset-0 bg-graphite-950/80" aria-hidden />
          <div role="alertdialog" aria-modal="true" className="relative w-full max-w-sm rounded-2xl bg-surface p-6 text-center">
            <p className="text-lg font-bold text-stock-ok">Contraseña actualizada</p>
            <p className="mt-2 text-sm text-ink-muted">
              Se cerraron todas las sesiones, incluida esta. Vuelve a iniciar
              sesión con la contraseña nueva.
            </p>
            <a
              href="/login"
              className="mt-4 inline-flex h-touch-lg w-full items-center justify-center rounded-xl bg-industrial-600 font-bold text-white"
            >
              Ir al inicio de sesión
            </a>
          </div>
        </div>
      )}

      {abierto && !listo && (
        <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto p-4">
          <div className="absolute inset-0 bg-graphite-950/70" onClick={cerrar} aria-hidden />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="cambiar-pwd"
            className="relative my-8 w-full max-w-md rounded-2xl bg-surface p-5 shadow-2xl"
          >
            <h2 id="cambiar-pwd" className="text-lg font-bold text-ink">
              Cambiar mi contraseña
            </h2>
            <p className="mt-2 rounded-xl bg-stock-low-soft px-3 py-2 text-sm font-semibold text-stock-low">
              Al guardar se cerrarán todas las sesiones abiertas, incluida esta.
            </p>

            <div className="mt-4 flex flex-col gap-3">
              <Campo label="Contraseña actual" error={err('currentPassword')}>
                <input
                  type={ver ? 'text' : 'password'}
                  value={actual}
                  onChange={(e) => setActual(e.target.value)}
                  autoComplete="current-password"
                  autoFocus
                  className={inputCls(err('currentPassword'))}
                />
              </Campo>

              <Campo label="Contraseña nueva (mínimo 12)" error={err('newPassword')}>
                <input
                  type={ver ? 'text' : 'password'}
                  value={nueva}
                  onChange={(e) => setNueva(e.target.value)}
                  autoComplete="new-password"
                  className={inputCls(err('newPassword'))}
                />
                {fuerza && (
                  <span
                    className={`text-xs font-semibold ${
                      fuerza === 'corta' ? 'text-stock-out'
                      : fuerza === 'aceptable' ? 'text-stock-low'
                      : 'text-stock-ok'
                    }`}
                  >
                    {nueva.length} caracteres · {fuerza}
                  </span>
                )}
              </Campo>

              <Campo label="Repite la contraseña nueva" error={err('confirmPassword')}>
                <input
                  type={ver ? 'text' : 'password'}
                  value={confirmar}
                  onChange={(e) => setConfirmar(e.target.value)}
                  autoComplete="new-password"
                  className={inputCls(err('confirmPassword'))}
                />
              </Campo>

              <label className="flex items-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={ver}
                  onChange={(e) => setVer(e.target.checked)}
                  className="size-5 accent-industrial-600"
                />
                Mostrar las contraseñas
              </label>
            </div>

            {error && (
              <p role="alert" className="mt-3 rounded-xl bg-stock-out-soft px-3 py-2 text-sm font-semibold text-stock-out">
                {error}
              </p>
            )}

            <div className="mt-4 flex gap-2">
              <button type="button" onClick={cerrar}
                className="h-touch-lg flex-1 rounded-xl border border-hairline font-semibold text-ink">
                Cancelar
              </button>
              <button
                type="button"
                onClick={enviar}
                disabled={pending || !actual || nueva.length < 12 || nueva !== confirmar}
                className="h-touch-lg flex-1 rounded-xl bg-industrial-600 font-bold text-white disabled:opacity-40"
              >
                {pending ? 'Guardando…' : 'Cambiar y cerrar sesiones'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function inputCls(error?: string) {
  return [
    'h-touch-lg w-full rounded-xl border bg-surface px-4 text-base text-ink',
    'focus:outline-none focus:ring-2',
    error
      ? 'border-stock-out focus:border-stock-out focus:ring-stock-out/40'
      : 'border-hairline focus:border-industrial-600 focus:ring-industrial-600/40',
  ].join(' ')
}

function Campo({
  label, error, children,
}: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm font-medium text-ink-muted">{label}</span>
      {children}
      {error && <span className="text-xs font-semibold text-stock-out">{error}</span>}
    </label>
  )
}
