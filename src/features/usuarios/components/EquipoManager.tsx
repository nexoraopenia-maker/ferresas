'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  cambiarEstadoUsuario, cambiarRolesUsuario, invitarUsuario, revocarInvitacion,
} from '../actions'

type Rol = 'ADMIN' | 'VENDEDOR' | 'CAJERO' | 'ALMACENERO' | 'CONTADOR'

const ETIQUETA_ROL: Record<string, string> = {
  OWNER: 'Dueño', ADMIN: 'Administrador', VENDEDOR: 'Vendedor',
  CAJERO: 'Cajero', ALMACENERO: 'Almacenero', CONTADOR: 'Contador',
}

export interface Miembro {
  id: string
  name: string
  email: string
  role: string
  extraRoles: string[]
  isActive: boolean
  lastLoginAt: string | null
  sucursales: string[]
  gestionable: boolean
}

export interface Pendiente {
  id: string
  email: string
  role: string
  extraRoles: string[]
  expiresAt: string
}

const campo = 'h-touch rounded-xl border border-hairline bg-surface px-3 text-base text-ink'

export function EquipoManager({
  yo, rolesAsignables, sucursales, puedeOperar, miembros, invitaciones,
}: {
  yo: string
  rolesAsignables: string[]
  sucursales: { id: string; name: string }[]
  puedeOperar: boolean
  miembros: Miembro[]
  invitaciones: Pendiente[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [enlace, setEnlace] = useState<string | null>(null)

  const [email, setEmail] = useState('')
  const [rol, setRol] = useState<string>(rolesAsignables[0] ?? '')
  const [extra, setExtra] = useState<string[]>([])
  const [sedes, setSedes] = useState<string[]>([])

  const alternar = (lista: string[], v: string) =>
    lista.includes(v) ? lista.filter((x) => x !== v) : [...lista, v]

  const invitar = () => {
    setError(null); setEnlace(null)
    startTransition(async () => {
      const res = await invitarUsuario({ email, role: rol, extraRoles: extra, branchIds: sedes })
      if (!res.ok) { setError(res.message); return }
      // El token solo existe en esta respuesta: se muestra una vez.
      setEnlace(`${window.location.origin}${res.data.enlace}`)
      setEmail(''); setExtra([]); setSedes([])
      router.refresh()
    })
  }

  const ejecutar = (fn: () => Promise<{ ok: boolean; message?: string }>) => {
    setError(null)
    startTransition(async () => {
      const res = await fn()
      if (!res.ok) { setError(res.message ?? 'No se pudo completar.'); return }
      router.refresh()
    })
  }

  return (
    <div className="flex flex-col gap-5">
      {error && (
        <p role="alert" className="rounded-xl bg-stock-out-soft px-3 py-2 text-sm font-semibold text-stock-out">
          {error}
        </p>
      )}

      {puedeOperar && rolesAsignables.length > 0 && (
        <section className="rounded-2xl border border-hairline bg-surface p-4">
          <h2 className="font-bold text-ink">Invitar a alguien</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium text-ink-muted">Correo</span>
              <input
                type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                autoComplete="off" className={campo}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium text-ink-muted">Rol principal</span>
              <select
                value={rol} onChange={(e) => { setRol(e.target.value); setExtra((x) => x.filter((r) => r !== e.target.value)) }}
                className={campo}
              >
                {rolesAsignables.map((r) => <option key={r} value={r}>{ETIQUETA_ROL[r] ?? r}</option>)}
              </select>
            </label>
          </div>

          {rolesAsignables.length > 1 && (
            <fieldset className="mt-3">
              <legend className="text-sm font-medium text-ink-muted">Roles adicionales (se suman)</legend>
              <div className="mt-1 flex flex-wrap gap-2">
                {rolesAsignables.filter((r) => r !== rol).map((r) => (
                  <label key={r} className="flex items-center gap-1.5 rounded-lg border border-hairline px-2.5 py-1.5 text-sm text-ink">
                    <input type="checkbox" checked={extra.includes(r)} onChange={() => setExtra((x) => alternar(x, r))} />
                    {ETIQUETA_ROL[r] ?? r}
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          {sucursales.length > 0 && (
            <fieldset className="mt-3">
              <legend className="text-sm font-medium text-ink-muted">Sucursales</legend>
              <div className="mt-1 flex flex-wrap gap-2">
                {sucursales.map((s) => (
                  <label key={s.id} className="flex items-center gap-1.5 rounded-lg border border-hairline px-2.5 py-1.5 text-sm text-ink">
                    <input type="checkbox" checked={sedes.includes(s.id)} onChange={() => setSedes((x) => alternar(x, s.id))} />
                    {s.name}
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          <button
            type="button" onClick={invitar} disabled={pending || !email.includes('@') || !rol}
            className="mt-4 h-touch-lg w-full rounded-xl bg-industrial-600 font-bold text-white disabled:opacity-40"
          >
            {pending ? 'Creando…' : 'Crear invitación'}
          </button>

          {enlace && (
            <div className="mt-3 rounded-xl border border-industrial-600/40 bg-surface-sunken p-3">
              <p className="text-sm font-semibold text-ink">
                Comparte este enlace con la persona. Solo se muestra ahora y vale 7 días.
              </p>
              <input
                readOnly value={enlace} onFocus={(e) => e.currentTarget.select()}
                className="mt-2 w-full rounded-lg border border-hairline bg-surface px-2 py-2 font-mono text-xs text-ink"
              />
            </div>
          )}
        </section>
      )}

      {invitaciones.length > 0 && (
        <section>
          <h2 className="mb-2 font-bold text-ink">Invitaciones pendientes</h2>
          <ul className="flex flex-col gap-2">
            {invitaciones.map((i) => (
              <li key={i.id} className="flex items-center justify-between gap-2 rounded-xl border border-hairline bg-surface p-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink">{i.email}</p>
                  <p className="text-xs text-ink-muted">
                    {[i.role, ...i.extraRoles].map((r) => ETIQUETA_ROL[r] ?? r).join(' + ')} · vence {new Date(i.expiresAt).toLocaleDateString('es-PE')}
                  </p>
                </div>
                {puedeOperar && (
                  <button
                    type="button" disabled={pending}
                    onClick={() => ejecutar(() => revocarInvitacion({ invitationId: i.id }))}
                    className="shrink-0 text-xs font-semibold text-stock-out"
                  >
                    Cancelar
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2 className="mb-2 font-bold text-ink">Equipo</h2>
        <ul className="flex flex-col gap-2">
          {miembros.map((m) => (
            <li key={m.id} className={`rounded-xl border border-hairline bg-surface p-3 ${m.isActive ? '' : 'opacity-60'}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink">
                    {m.name}{m.id === yo && <span className="ml-1 text-xs font-normal text-ink-muted">(tú)</span>}
                  </p>
                  <p className="truncate text-xs text-ink-muted">{m.email}</p>
                  <p className="mt-1 text-xs text-ink-muted">
                    {[m.role, ...m.extraRoles].map((r) => ETIQUETA_ROL[r] ?? r).join(' + ')}
                    {m.sucursales.length > 0 && ` · ${m.sucursales.join(', ')}`}
                    {!m.isActive && ' · desactivado'}
                  </p>
                </div>
                {puedeOperar && m.gestionable && (
                  <button
                    type="button" disabled={pending}
                    onClick={() => ejecutar(() => cambiarEstadoUsuario({ userId: m.id, activo: !m.isActive }))}
                    className={`shrink-0 text-xs font-semibold ${m.isActive ? 'text-stock-out' : 'text-industrial-700'}`}
                  >
                    {m.isActive ? 'Desactivar' : 'Reactivar'}
                  </button>
                )}
              </div>
              {puedeOperar && m.gestionable && m.isActive && (
                <label className="mt-2 flex items-center gap-2 text-xs text-ink-muted">
                  Rol
                  <select
                    value={m.role} disabled={pending}
                    onChange={(e) =>
                      ejecutar(() => cambiarRolesUsuario({
                        userId: m.id, role: e.target.value as Rol,
                        extraRoles: m.extraRoles.filter((r) => r !== e.target.value),
                      }))
                    }
                    className="h-touch rounded-lg border border-hairline bg-surface px-2 text-sm text-ink"
                  >
                    {Array.from(new Set([m.role, ...rolesAsignables])).map((r) => (
                      <option key={r} value={r} disabled={!rolesAsignables.includes(r)}>{ETIQUETA_ROL[r] ?? r}</option>
                    ))}
                  </select>
                </label>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
