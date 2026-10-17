'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { avisoEstablecimiento } from '../establecimiento'
import { assignBranches, createBranch, deleteBranch, updateBranch } from '../actions'

export interface BranchRow {
  id: string
  code: string
  name: string
  establishmentCode: string
  seriesNumber: number
  address: string | null
  ubigeo: string | null
  phone: string | null
  isDefault: boolean
  isActive: boolean
  responsable: string | null
  almacenes: number
  conStock: number
}

export interface UsuarioRow {
  id: string
  nombre: string
  email: string
  role: string
  sucursales: string[]
}

/**
 * Gestión de sucursales.
 *
 * El número de serie se muestra en grande junto a cada sucursal porque es el
 * dato con consecuencias: explica por qué un local emite B002 y, sobre todo,
 * por qué no se puede cambiar después de haber emitido con él.
 */
export function BranchManager({
  sucursales,
  usuarios,
  puedeGestionar,
}: {
  sucursales: BranchRow[]
  usuarios: UsuarioRow[]
  puedeGestionar: boolean
}) {
  const router = useRouter()
  const [creando, setCreando] = useState(false)
  const [editando, setEditando] = useState<BranchRow | null>(null)
  const [dandoBaja, setDandoBaja] = useState<BranchRow | null>(null)
  const [asignando, setAsignando] = useState<UsuarioRow | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const correr = (fn: () => Promise<{ ok: boolean; message?: string }>, alCerrar: () => void) => {
    setError(null)
    startTransition(async () => {
      const res = await fn()
      if (!res.ok) { setError(res.message ?? 'No se pudo completar.'); return }
      alCerrar()
      router.refresh()
    })
  }

  return (
    <>
      {puedeGestionar && (
        <button
          type="button"
          onClick={() => { setCreando(true); setError(null) }}
          className="h-touch-lg rounded-xl bg-industrial-600 px-5 font-bold text-white"
        >
          Nueva sucursal
        </button>
      )}

      <ul className="flex flex-col gap-3">
        {sucursales.map((s) => (
          <li key={s.id} className="rounded-2xl border border-hairline bg-surface p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="flex items-center gap-2 font-bold text-ink">
                  {s.name}
                  {s.isDefault && (
                    <span className="rounded-full bg-industrial-100 px-2 py-0.5 text-xs font-bold text-industrial-800 dark:bg-industrial-950 dark:text-industrial-300">
                      Casa matriz
                    </span>
                  )}
                  {!s.isActive && (
                    <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-xs font-bold text-ink-muted">
                      Inactiva
                    </span>
                  )}
                </p>
                <p className="font-mono text-xs text-ink-muted">
                  {s.code} · establecimiento {s.establishmentCode}
                  {s.ubigeo && ` · ubigeo ${s.ubigeo}`}
                </p>
                {s.address && <p className="text-sm text-ink-muted">{s.address}</p>}
                <p className="mt-1 text-xs text-ink-muted">
                  {s.almacenes} {s.almacenes === 1 ? 'almacén' : 'almacenes'}
                  {s.conStock > 0 && ` · ${s.conStock} con stock`}
                  {s.responsable && ` · responsable: ${s.responsable}`}
                </p>
              </div>

              <div className="shrink-0 text-right">
                <p className="text-xs uppercase tracking-wide text-ink-muted">Serie</p>
                <p className="font-mono text-2xl font-bold text-ink">
                  {String(s.seriesNumber).padStart(3, '0')}
                </p>
                <p className="font-mono text-xs text-ink-muted">
                  B{String(s.seriesNumber).padStart(3, '0')} · F{String(s.seriesNumber).padStart(3, '0')}
                </p>
              </div>
            </div>

            {puedeGestionar && (
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => { setEditando(s); setError(null) }}
                  className="h-touch rounded-lg border border-hairline px-4 text-sm font-semibold text-ink"
                >
                  Editar
                </button>
                {!s.isDefault && (
                  <button
                    type="button"
                    onClick={() => { setDandoBaja(s); setError(null) }}
                    className="h-touch rounded-lg border border-stock-out/40 px-4 text-sm font-semibold text-stock-out"
                  >
                    Dar de baja
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>

      {/* ───────── Usuarios y sus sucursales ───────── */}
      <section>
        <h2 className="text-lg font-bold text-ink">Quién entra a cada sucursal</h2>
        <p className="text-sm text-ink-muted">
          Un usuario solo puede vender, mover stock y abrir caja en las
          sucursales que tenga asignadas.
        </p>

        <ul className="mt-3 flex flex-col gap-2">
          {usuarios.map((u) => (
            <li
              key={u.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-hairline bg-surface p-3"
            >
              <div className="min-w-0">
                <p className="font-semibold text-ink">{u.nombre}</p>
                <p className="truncate text-xs text-ink-muted">
                  {u.email} · {u.role.toLowerCase()}
                </p>
                <p className="mt-1 text-xs text-ink-muted">
                  {u.sucursales.length === 0
                    ? '⚠ Sin sucursal: no puede operar'
                    : u.sucursales.join(', ')}
                </p>
              </div>
              {puedeGestionar && (
                <button
                  type="button"
                  onClick={() => { setAsignando(u); setError(null) }}
                  className="h-touch shrink-0 rounded-lg border border-hairline px-4 text-sm font-semibold text-ink"
                >
                  Asignar
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      {/* ───────── Modales ───────── */}
      {creando && (
        <Modal titulo="Nueva sucursal" onCerrar={() => setCreando(false)}>
          <FormCrear
            error={error}
            pending={pending}
            usuarios={usuarios}
            onEnviar={(datos) => correr(() => createBranch(datos), () => setCreando(false))}
          />
        </Modal>
      )}

      {editando && (
        <Modal titulo={`Editar ${editando.name}`} onCerrar={() => setEditando(null)}>
          <FormEditar
            sucursal={editando}
            usuarios={usuarios}
            error={error}
            pending={pending}
            onEnviar={(datos) => correr(() => updateBranch(datos), () => setEditando(null))}
          />
        </Modal>
      )}

      {dandoBaja && (
        <Modal titulo={`Dar de baja ${dandoBaja.name}`} onCerrar={() => setDandoBaja(null)}>
          <FormBaja
            sucursal={dandoBaja}
            error={error}
            pending={pending}
            onEnviar={(reason) =>
              correr(() => deleteBranch({ branchId: dandoBaja.id, reason }), () => setDandoBaja(null))
            }
          />
        </Modal>
      )}

      {asignando && (
        <Modal titulo={`Sucursales de ${asignando.nombre}`} onCerrar={() => setAsignando(null)}>
          <FormAsignar
            usuario={asignando}
            sucursales={sucursales.filter((s) => s.isActive)}
            error={error}
            pending={pending}
            onEnviar={(branchIds) =>
              correr(() => assignBranches({ userId: asignando.id, branchIds }), () => setAsignando(null))
            }
          />
        </Modal>
      )}
    </>
  )
}

// ═══════════════════════════════════════════════════════════════════════════

function Modal({
  titulo, children, onCerrar,
}: { titulo: string; children: React.ReactNode; onCerrar: () => void }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4">
      <div className="absolute inset-0 bg-graphite-950/70" onClick={onCerrar} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        className="relative max-h-[85dvh] w-full max-w-md overflow-y-auto rounded-2xl bg-surface p-5 shadow-2xl"
      >
        <h2 className="text-lg font-bold text-ink">{titulo}</h2>
        <div className="mt-3">{children}</div>
        <button
          type="button"
          onClick={onCerrar}
          className="mt-3 h-touch w-full rounded-xl text-sm font-semibold text-ink-muted"
        >
          Cancelar
        </button>
      </div>
    </div>
  )
}

function Campo({
  label, valor, onCambio, placeholder, ayuda, inputMode,
}: {
  label: string
  valor: string
  onCambio: (v: string) => void
  placeholder?: string
  ayuda?: string
  inputMode?: 'numeric' | 'text'
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm font-medium text-ink-muted">{label}</span>
      <input
        value={valor}
        inputMode={inputMode}
        onChange={(e) => onCambio(e.target.value)}
        placeholder={placeholder}
        className="h-touch-lg rounded-xl border border-hairline bg-surface px-3 text-base text-ink focus:border-industrial-600 focus:outline-none focus:ring-2 focus:ring-industrial-600/40"
      />
      {ayuda && <span className="text-xs text-ink-muted">{ayuda}</span>}
    </label>
  )
}

function Aviso({ error }: { error: string | null }) {
  if (!error) return null
  return (
    <p role="alert" className="rounded-xl bg-stock-out-soft px-3 py-2 text-sm font-semibold text-stock-out">
      {error}
    </p>
  )
}

function FormCrear({
  onEnviar, error, pending, usuarios,
}: {
  onEnviar: (d: Record<string, unknown>) => void
  error: string | null
  pending: boolean
  usuarios: UsuarioRow[]
}) {
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [establishmentCode, setEst] = useState('')
  const [address, setAddress] = useState('')
  const [ubigeo, setUbigeo] = useState('')
  const [phone, setPhone] = useState('')
  const [managerId, setManager] = useState('')

  return (
    <div className="flex flex-col gap-3">
      <Campo label="Código interno" valor={code} onCambio={setCode}
        placeholder="SJL" ayuda="El que usa el personal. Letras, números y guiones." />
      <Campo label="Nombre" valor={name} onCambio={setName} placeholder="San Juan de Lurigancho" />
      <Campo label="Código de establecimiento SUNAT" valor={establishmentCode} onCambio={setEst}
        placeholder="0001" inputMode="numeric"
        ayuda="Cuatro dígitos. Lo asigna SUNAT al dar de alta el anexo en tu RUC; 0000 es la casa matriz." />

      {/*
        * Aviso explícito de que el código NO se verifica contra el RUC.
        * SUNAT solo expone los anexos detrás de la Clave SOL, así que esto se
        * teclea — y un código equivocado atribuye los comprobantes de esta
        * sucursal a un establecimiento que no es tuyo. Callarlo sería dejar
        * que el usuario lo descubra cuando ya haya emitido.
        */}
      {/^\d{4}$/.test(establishmentCode) && avisoEstablecimiento(establishmentCode) && (
        <p className="rounded-xl border border-stock-low/40 bg-stock-low-soft px-3 py-2 text-xs font-semibold text-stock-low">
          ⚠ {avisoEstablecimiento(establishmentCode)}
        </p>
      )}
      <Campo label="Dirección" valor={address} onCambio={setAddress} />
      <Campo label="Ubigeo" valor={ubigeo} onCambio={setUbigeo}
        placeholder="150132" inputMode="numeric" ayuda="Seis dígitos del INEI. Opcional." />
      <Campo label="Teléfono" valor={phone} onCambio={setPhone} />

      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium text-ink-muted">Responsable (opcional)</span>
        <select
          value={managerId}
          onChange={(e) => setManager(e.target.value)}
          className="h-touch-lg rounded-xl border border-hairline bg-surface px-3 text-base text-ink"
        >
          <option value="">Sin asignar</option>
          {usuarios.map((u) => (
            <option key={u.id} value={u.id}>{u.nombre}</option>
          ))}
        </select>
      </label>

      <p className="rounded-xl bg-surface-sunken px-3 py-2 text-xs text-ink-muted">
        El número de serie se asigna automáticamente y <strong>no se puede
        cambiar después</strong>: va impreso en los comprobantes que emita
        este local.
      </p>

      <Aviso error={error} />

      <button
        type="button"
        disabled={pending}
        onClick={() =>
          onEnviar({
            code, name, establishmentCode,
            address: address || undefined,
            ubigeo: ubigeo || undefined,
            phone: phone || undefined,
            managerId: managerId || undefined,
            crearAlmacen: true,
          })
        }
        className="h-touch-lg w-full rounded-xl bg-industrial-600 font-bold text-white disabled:opacity-40"
      >
        {pending ? 'Creando…' : 'Crear sucursal'}
      </button>
    </div>
  )
}

function FormEditar({
  sucursal, usuarios, onEnviar, error, pending,
}: {
  sucursal: BranchRow
  usuarios: UsuarioRow[]
  onEnviar: (d: Record<string, unknown>) => void
  error: string | null
  pending: boolean
}) {
  const [name, setName] = useState(sucursal.name)
  const [address, setAddress] = useState(sucursal.address ?? '')
  const [ubigeo, setUbigeo] = useState(sucursal.ubigeo ?? '')
  const [phone, setPhone] = useState(sucursal.phone ?? '')
  const [managerId, setManager] = useState('')
  const [isActive, setActive] = useState(sucursal.isActive)

  return (
    <div className="flex flex-col gap-3">
      <p className="rounded-xl bg-surface-sunken px-3 py-2 text-xs text-ink-muted">
        Código <span className="font-mono font-bold">{sucursal.code}</span>,
        establecimiento <span className="font-mono font-bold">{sucursal.establishmentCode}</span> y
        serie <span className="font-mono font-bold">{String(sucursal.seriesNumber).padStart(3, '0')}</span>{' '}
        no se editan: ya hay comprobantes emitidos con ellos.
      </p>

      <Campo label="Nombre" valor={name} onCambio={setName} />
      <Campo label="Dirección" valor={address} onCambio={setAddress} />
      <Campo label="Ubigeo" valor={ubigeo} onCambio={setUbigeo} inputMode="numeric" />
      <Campo label="Teléfono" valor={phone} onCambio={setPhone} />

      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium text-ink-muted">Responsable</span>
        <select
          value={managerId}
          onChange={(e) => setManager(e.target.value)}
          className="h-touch-lg rounded-xl border border-hairline bg-surface px-3 text-base text-ink"
        >
          <option value="">Sin cambios</option>
          <option value="__ninguno__">Quitar responsable</option>
          {usuarios.map((u) => (
            <option key={u.id} value={u.id}>{u.nombre}</option>
          ))}
        </select>
      </label>

      {!sucursal.isDefault && (
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={isActive}
            onChange={(e) => setActive(e.target.checked)}
            className="mt-0.5 size-5 accent-industrial-600"
          />
          <span className="text-sm font-semibold text-ink">
            Activa
            <span className="mt-0.5 block font-normal text-ink-muted">
              Al desactivarla deja de aparecer en el POS, pero su historial
              y su serie se conservan.
            </span>
          </span>
        </label>
      )}

      <Aviso error={error} />

      <button
        type="button"
        disabled={pending}
        onClick={() =>
          onEnviar({
            branchId: sucursal.id,
            name,
            address: address || '',
            ubigeo: ubigeo || undefined,
            phone: phone || '',
            managerId: managerId === '' ? undefined : managerId === '__ninguno__' ? null : managerId,
            isActive: sucursal.isDefault ? undefined : isActive,
          })
        }
        className="h-touch-lg w-full rounded-xl bg-industrial-600 font-bold text-white disabled:opacity-40"
      >
        {pending ? 'Guardando…' : 'Guardar'}
      </button>
    </div>
  )
}

function FormBaja({
  sucursal, onEnviar, error, pending,
}: {
  sucursal: BranchRow
  onEnviar: (reason: string) => void
  error: string | null
  pending: boolean
}) {
  const [reason, setReason] = useState('')
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-ink">
        La sucursal no se borra: queda dada de baja y su historial se conserva
        entero. Su número de serie <strong>no se reutilizará</strong>, porque
        los comprobantes que emitió siguen apuntando a él.
      </p>

      {sucursal.conStock > 0 && (
        <p className="rounded-xl bg-stock-low-soft px-3 py-2 text-sm font-semibold text-stock-low">
          Todavía tiene {sucursal.conStock}{' '}
          {sucursal.conStock === 1 ? 'producto' : 'productos'} con stock.
          Transfiérelo antes: dar de baja el local haría desaparecer ese
          inventario de los reportes sin que nadie lo haya movido.
        </p>
      )}

      <Campo label="Motivo" valor={reason} onCambio={setReason}
        placeholder="Cierre del local por fin de contrato"
        ayuda="Queda en el registro de auditoría." />

      <Aviso error={error} />

      <button
        type="button"
        disabled={pending || reason.trim().length < 5}
        onClick={() => onEnviar(reason)}
        className="h-touch-lg w-full rounded-xl bg-stock-out font-bold text-white disabled:opacity-40"
      >
        {pending ? 'Dando de baja…' : 'Dar de baja'}
      </button>
    </div>
  )
}

function FormAsignar({
  usuario, sucursales, onEnviar, error, pending,
}: {
  usuario: UsuarioRow
  sucursales: BranchRow[]
  onEnviar: (ids: string[]) => void
  error: string | null
  pending: boolean
}) {
  const [seleccion, setSeleccion] = useState<string[]>(
    sucursales.filter((s) => usuario.sucursales.includes(s.name)).map((s) => s.id),
  )

  const alternar = (id: string) =>
    setSeleccion((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-ink-muted">
        Marca todas las sucursales en las que puede operar. Lo que desmarques
        se le quita.
      </p>

      <ul className="flex flex-col gap-2">
        {sucursales.map((s) => (
          <li key={s.id}>
            <label className="flex items-center gap-2 rounded-xl border border-hairline p-3">
              <input
                type="checkbox"
                checked={seleccion.includes(s.id)}
                onChange={() => alternar(s.id)}
                className="size-5 accent-industrial-600"
              />
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-ink">{s.name}</span>
                <span className="block font-mono text-xs text-ink-muted">
                  {s.code} · serie {String(s.seriesNumber).padStart(3, '0')}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>

      {seleccion.length === 0 && (
        <p className="rounded-xl bg-stock-low-soft px-3 py-2 text-xs font-semibold text-stock-low">
          Sin ninguna marcada, este usuario no podrá vender ni mover stock.
        </p>
      )}

      <Aviso error={error} />

      <button
        type="button"
        disabled={pending}
        onClick={() => onEnviar(seleccion)}
        className="h-touch-lg w-full rounded-xl bg-industrial-600 font-bold text-white disabled:opacity-40"
      >
        {pending ? 'Guardando…' : 'Guardar asignación'}
      </button>
    </div>
  )
}
