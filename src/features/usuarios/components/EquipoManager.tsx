'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  cambiarEstadoUsuario, cambiarPasswordUsuario, cambiarRolesUsuario, crearUsuarioDirecto,
  invitarUsuario, revocarInvitacion,
} from '../actions'
import { restablecerMfaAction } from '@/features/seguridad/mfa-actions'
import { desbloquearPinUsuario, establecerPinUsuario, quitarPinUsuario, cerrarSesionesDelUsuario } from '@/features/seguridad/actions'

/** Contraseña aleatoria legible (sin 0/O ni 1/l/I). Se genera en el navegador y se muestra una vez. */
function generarClave(largo = 12): string {
  const alfabeto = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = crypto.getRandomValues(new Uint32Array(largo))
  return Array.from(bytes, (b) => alfabeto[b % alfabeto.length]).join('')
}

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
  puedeCambiarPassword: boolean
  tienePin: boolean
  pinBloqueado: boolean
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

  const [modo, setModo] = useState<'enlace' | 'directo'>('enlace')
  const [nombre, setNombre] = useState('')
  const [clave, setClave] = useState('')
  const [creado, setCreado] = useState<{ email: string; clave: string } | null>(null)
  const [cambiandoId, setCambiandoId] = useState<string | null>(null)
  const [claveNueva, setClaveNueva] = useState('')
  const [pinId, setPinId] = useState<string | null>(null)
  const [pinNuevo, setPinNuevo] = useState('')
  const [claveAplicada, setClaveAplicada] = useState<{ id: string; clave: string } | null>(null)
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

  const crearDirecto = () => {
    setError(null); setCreado(null)
    startTransition(async () => {
      const res = await crearUsuarioDirecto({ name: nombre, email, password: clave, role: rol, extraRoles: extra, branchIds: sedes })
      if (!res.ok) { setError(res.message); return }
      // La contraseña se muestra UNA vez, para dársela a la persona.
      setCreado({ email, clave })
      setNombre(''); setEmail(''); setClave(''); setExtra([]); setSedes([])
      router.refresh()
    })
  }

  const guardarPin = (userId: string) => {
    ejecutar(async () => {
      const r = await establecerPinUsuario({ userId, pin: pinNuevo })
      if (r.ok) { setPinId(null); setPinNuevo('') }
      return r
    })
  }

  const aplicarClave = (userId: string) => {
    setError(null); setClaveAplicada(null)
    startTransition(async () => {
      const res = await cambiarPasswordUsuario({ userId, password: claveNueva })
      if (!res.ok) { setError(res.message); return }
      setClaveAplicada({ id: userId, clave: claveNueva })
      setCambiandoId(null); setClaveNueva('')
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
          <h2 className="font-bold text-ink">Agregar a alguien</h2>
          <div role="tablist" className="mt-3 grid grid-cols-2 gap-1 rounded-xl bg-surface-sunken p-1">
            {([['enlace', 'Invitar por enlace'], ['directo', 'Crear con contraseña']] as const).map(([m, texto]) => (
              <button
                key={m} type="button" role="tab" aria-selected={modo === m}
                onClick={() => { setModo(m); setError(null); setEnlace(null); setCreado(null) }}
                className={`h-touch rounded-lg text-sm font-semibold ${modo === m ? 'bg-surface text-ink shadow-sm' : 'text-ink-muted'}`}
              >
                {texto}
              </button>
            ))}
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {modo === 'directo' && (
              <label className="flex flex-col gap-1 sm:col-span-2">
                <span className="text-sm font-medium text-ink-muted">Nombre</span>
                <input value={nombre} onChange={(e) => setNombre(e.target.value)} autoComplete="off" className={campo} />
              </label>
            )}
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

          {modo === 'directo' && (
            <div className="mt-3 flex flex-col gap-1">
              <span className="text-sm font-medium text-ink-muted">Contraseña (mínimo 8 caracteres)</span>
              <div className="flex gap-2">
                <input
                  value={clave} onChange={(e) => setClave(e.target.value)} autoComplete="new-password"
                  className={`${campo} min-w-0 flex-1 font-mono`}
                />
                <button type="button" onClick={() => setClave(generarClave())} className="h-touch shrink-0 rounded-xl border border-hairline px-3 text-sm font-semibold text-ink">
                  Generar
                </button>
              </div>
            </div>
          )}

          <button
            type="button"
            onClick={modo === 'directo' ? crearDirecto : invitar}
            disabled={pending || !email.includes('@') || !rol || (modo === 'directo' && (nombre.trim().length < 2 || clave.length < 8))}
            className="mt-4 h-touch-lg w-full rounded-xl bg-industrial-600 font-bold text-white disabled:opacity-40"
          >
            {pending ? 'Creando…' : modo === 'directo' ? 'Crear usuario' : 'Crear invitación'}
          </button>

          {creado && (
            <div className="mt-3 rounded-xl border border-industrial-600/40 bg-surface-sunken p-3 text-sm">
              <p className="font-semibold text-ink">Usuario creado. Entrégale estos datos; la contraseña no se vuelve a mostrar.</p>
              <p className="mt-1 font-mono text-xs text-ink">{creado.email} · {creado.clave}</p>
            </div>
          )}

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
                {puedeOperar && m.puedeCambiarPassword && (
                  <div className="flex shrink-0 flex-wrap justify-end gap-x-3 gap-y-1">
                    <button
                      type="button" disabled={pending}
                      onClick={() => { setCambiandoId(cambiandoId === m.id ? null : m.id); setClaveNueva(''); setClaveAplicada(null) }}
                      className="text-xs font-semibold text-industrial-700 dark:text-industrial-300"
                    >
                      Contraseña
                    </button>
                    <button
                      type="button" disabled={pending}
                      onClick={() => { setPinId(pinId === m.id ? null : m.id); setPinNuevo('') }}
                      className="text-xs font-semibold text-industrial-700 dark:text-industrial-300"
                    >
                      {m.tienePin ? 'Cambiar PIN' : 'Poner PIN'}
                    </button>
                    {m.pinBloqueado && (
                      <button type="button" disabled={pending} onClick={() => ejecutar(() => desbloquearPinUsuario(m.id))} className="text-xs font-bold text-stock-out">
                        Desbloquear PIN
                      </button>
                    )}
                    {m.tienePin && (
                      <button type="button" disabled={pending} onClick={() => ejecutar(() => quitarPinUsuario(m.id))} className="text-xs font-semibold text-ink-muted">
                        Quitar PIN
                      </button>
                    )}
                    <button
                      type="button" disabled={pending}
                      onClick={() => { if (window.confirm(`¿Cerrar todas las sesiones abiertas de ${m.name}?`)) ejecutar(() => cerrarSesionesDelUsuario(m.id)) }}
                      className="text-xs font-semibold text-ink-muted"
                    >
                      Cerrar sesiones
                    </button>
                    <button
                      type="button" disabled={pending}
                      onClick={() => { if (window.confirm(`¿Restablecer la verificación en dos pasos de ${m.name}? Se cerrarán sus sesiones.`)) ejecutar(() => restablecerMfaAction({ userId: m.id })) }}
                      className="text-xs font-semibold text-ink-muted"
                    >
                      Restablecer 2 pasos
                    </button>
                  </div>
                )}
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
              {cambiandoId === m.id && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <input
                    value={claveNueva} onChange={(e) => setClaveNueva(e.target.value)} autoComplete="new-password"
                    placeholder="Contraseña nueva" className={`${campo} min-w-0 flex-1 font-mono`}
                  />
                  <button type="button" onClick={() => setClaveNueva(generarClave())} className="h-touch rounded-xl border border-hairline px-3 text-sm font-semibold text-ink">Generar</button>
                  <button type="button" disabled={pending || claveNueva.length < 8} onClick={() => aplicarClave(m.id)} className="h-touch rounded-xl bg-industrial-600 px-4 text-sm font-bold text-white disabled:opacity-40">Guardar</button>
                  <p className="w-full text-xs text-ink-muted">Cierra todas las sesiones abiertas de esa cuenta{m.id === yo ? ' (también la tuya: tendrás que entrar de nuevo)' : ''}.</p>
                </div>
              )}
              {(m.tienePin || m.pinBloqueado) && (
                <p className={`mt-1 text-xs font-semibold ${m.pinBloqueado ? 'text-stock-out' : 'text-ink-muted'}`}>
                  {m.pinBloqueado ? 'PIN BLOQUEADO (5 intentos fallidos)' : 'Tiene PIN de cajero'}
                </p>
              )}
              {pinId === m.id && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <input
                    inputMode="numeric" maxLength={6} value={pinNuevo} onChange={(e) => setPinNuevo(e.target.value.replace(/\D/g, ''))}
                    placeholder="PIN de 4 a 6 números" autoComplete="off" className={`${campo} w-48 font-mono tracking-widest`}
                  />
                  <button type="button" disabled={pending || pinNuevo.length < 4} onClick={() => guardarPin(m.id)} className="h-touch rounded-xl bg-industrial-600 px-4 text-sm font-bold text-white disabled:opacity-40">Guardar PIN</button>
                  <p className="w-full text-xs text-ink-muted">Sirve para identificar a quien cobra en un dispositivo ya abierto. No da más permisos. Se bloquea a los 5 intentos fallidos.</p>
                </div>
              )}
              {claveAplicada?.id === m.id && (
                <p className="mt-2 rounded-lg bg-stock-ok-soft px-3 py-2 text-xs font-semibold text-stock-ok">
                  Contraseña cambiada: <span className="font-mono">{claveAplicada.clave}</span>. No se vuelve a mostrar.
                </p>
              )}
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
