'use client'

import { useMemo, useState } from 'react'

export interface AuditRow {
  id: string
  action: string
  actorEmail: string | null
  actorRole: string | null
  tenantName: string | null
  tenantSlug: string | null
  reason: string | null
  before: unknown
  after: unknown
  ipAddress: string | null
  impersonationId: string | null
  createdAt: string
}

/**
 * Catálogo de acciones auditadas.
 *
 * El color no decora: agrupa por GRAVEDAD, para que al abrir la tabla se vea
 * de un golpe si ha pasado algo serio. Rojo es destructivo o de acceso
 * privilegiado; ámbar toca dinero o permisos; verde restaura; gris es rutina.
 *
 * Una acción sin entrada aquí aparece en gris con su nombre crudo — así una
 * acción nueva se ve igualmente en lugar de desaparecer del registro.
 */
const ACCIONES: Record<string, { etiqueta: string; tono: 'grave' | 'aviso' | 'ok' | 'info' }> = {
  'tenant.suspend':             { etiqueta: 'Cuenta suspendida',      tono: 'grave' },
  'impersonation.start':        { etiqueta: 'Acceso de soporte',      tono: 'grave' },
  'tenant.password.reset':      { etiqueta: 'Contraseña reseteada',   tono: 'grave' },
  'superadmin.password.change': { etiqueta: 'Clave de Super Admin',   tono: 'grave' },
  'tenant.plan.change':         { etiqueta: 'Plan cambiado',          tono: 'aviso' },
  'tenant.trial.extend':        { etiqueta: 'Prueba extendida',       tono: 'aviso' },
  'tenant.profile.update':      { etiqueta: 'Perfil editado',         tono: 'aviso' },
  'stock.adjust':               { etiqueta: 'Ajuste de inventario',   tono: 'aviso' },
  'tenant.reactivate':          { etiqueta: 'Cuenta reactivada',      tono: 'ok' },
  'impersonation.end':          { etiqueta: 'Fin de soporte',         tono: 'ok' },
  'tenant.create.superadmin':   { etiqueta: 'Alta por soporte',       tono: 'info' },
  'tenant.register':            { etiqueta: 'Alta por autoservicio',  tono: 'info' },
  'taxdocument.issue':          { etiqueta: 'Comprobante emitido',    tono: 'info' },
  'taxdocument.status':         { etiqueta: 'Estado tributario',      tono: 'info' },
  'trial.expired':              { etiqueta: 'Prueba vencida',         tono: 'info' },
  'product.create.express':     { etiqueta: 'Alta exprés',            tono: 'info' },
  'billing.activate':           { etiqueta: 'Pago recibido',          tono: 'ok' },
  'billing.mark_past_due':      { etiqueta: 'Pago fallido',           tono: 'aviso' },
  'billing.cancel':             { etiqueta: 'Suscripción cancelada',  tono: 'grave' },
  'billing.sync':               { etiqueta: 'Sincronización',         tono: 'info' },
  'billing.noop':               { etiqueta: 'Aviso de pasarela',      tono: 'info' },
}

const TONOS = {
  grave: 'bg-stock-out-soft text-stock-out border-stock-out/30',
  aviso: 'bg-stock-low-soft text-stock-low border-stock-low/30',
  ok: 'bg-stock-ok-soft text-stock-ok border-stock-ok/30',
  info: 'bg-surface-sunken text-ink-muted border-hairline',
} as const

const GRUPOS = [
  { id: 'todo', label: 'Todo' },
  { id: 'grave', label: 'Críticas' },
  { id: 'aviso', label: 'Sensibles' },
  { id: 'ok', label: 'Restaurativas' },
] as const

/** Resume `before`/`after` en una frase legible, sin volcar JSON crudo. */
function resumirCambio(before: unknown, after: unknown): string | null {
  const b = (before ?? {}) as Record<string, unknown>
  const a = (after ?? {}) as Record<string, unknown>
  const claves = [...new Set([...Object.keys(b), ...Object.keys(a)])]
  if (claves.length === 0) return null

  const partes = claves.slice(0, 4).map((k) => {
    const antes = b[k]
    const despues = a[k]
    const fmt = (v: unknown) =>
      v === null || v === undefined || v === '' ? '—' : String(v).slice(0, 40)
    return antes !== undefined && despues !== undefined && antes !== despues
      ? `${k}: ${fmt(antes)} → ${fmt(despues)}`
      : `${k}: ${fmt(despues ?? antes)}`
  })

  return partes.join(' · ')
}

/**
 * Registro de auditoría.
 *
 * Sustituye la lista de texto plano anterior. El cambio que importa no es la
 * tabla: es que ahora se puede FILTRAR por gravedad. Un registro donde una
 * suspensión de cuenta se ve igual que un alta exprés de producto obliga a
 * leerlo entero para encontrar lo que pasó, y por eso nadie lo lee.
 */
export function AuditTable({ rows }: { rows: AuditRow[] }) {
  const [grupo, setGrupo] = useState<(typeof GRUPOS)[number]['id']>('todo')
  const [abierta, setAbierta] = useState<string | null>(null)

  const conteos = useMemo(() => {
    const m = { todo: rows.length, grave: 0, aviso: 0, ok: 0 } as Record<string, number>
    for (const r of rows) {
      const tono = ACCIONES[r.action]?.tono ?? 'info'
      if (tono in m) m[tono] = (m[tono] ?? 0) + 1
    }
    return m
  }, [rows])

  const visibles = useMemo(
    () =>
      grupo === 'todo'
        ? rows
        : rows.filter((r) => (ACCIONES[r.action]?.tono ?? 'info') === grupo),
    [rows, grupo],
  )

  return (
    <section className="overflow-hidden rounded-2xl border border-hairline bg-surface">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline px-4 py-3">
        <h2 className="font-bold text-ink">Auditoría</h2>
        <div role="group" aria-label="Filtrar por gravedad" className="flex flex-wrap gap-2">
          {GRUPOS.map((g) => (
            <button
              key={g.id}
              type="button"
              aria-pressed={grupo === g.id}
              onClick={() => setGrupo(g.id)}
              disabled={conteos[g.id] === 0 && g.id !== 'todo'}
              className={`h-touch rounded-full px-3 text-xs font-bold transition disabled:opacity-30 ${
                grupo === g.id
                  ? 'bg-graphite-900 text-white dark:bg-graphite-50 dark:text-graphite-900'
                  : 'border border-hairline text-ink'
              }`}
            >
              {g.label} <span className="opacity-70">{conteos[g.id] ?? 0}</span>
            </button>
          ))}
        </div>
      </header>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[44rem] text-sm">
          <thead className="bg-surface-sunken text-left text-ink-muted">
            <tr>
              <th className="px-3 py-2 font-semibold">Fecha</th>
              <th className="px-3 py-2 font-semibold">Acción</th>
              <th className="px-3 py-2 font-semibold">Ferretería</th>
              <th className="px-3 py-2 font-semibold">Usuario</th>
              <th className="px-3 py-2 font-semibold">Detalle</th>
            </tr>
          </thead>
          <tbody>
            {visibles.map((r) => {
              const meta = ACCIONES[r.action] ?? { etiqueta: r.action, tono: 'info' as const }
              const cambio = resumirCambio(r.before, r.after)
              const expandida = abierta === r.id
              const f = new Date(r.createdAt)

              return (
                <tr key={r.id} className="border-t border-hairline align-top">
                  <td className="whitespace-nowrap px-3 py-3">
                    <p className="font-mono text-xs text-ink">
                      {f.toLocaleDateString('es-PE', { day: '2-digit', month: 'short' })}
                    </p>
                    <p className="font-mono text-xs text-ink-muted">
                      {f.toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' })}
                    </p>
                  </td>

                  <td className="px-3 py-3">
                    <span className={`inline-block rounded-full border px-2 py-1 text-xs font-bold ${TONOS[meta.tono]}`}>
                      {meta.etiqueta}
                    </span>
                    {r.impersonationId && (
                      <span className="mt-1 block text-xs font-semibold text-stock-out">
                        durante impersonation
                      </span>
                    )}
                  </td>

                  <td className="px-3 py-3">
                    <p className="text-ink">{r.tenantName ?? '—'}</p>
                    {r.tenantSlug && (
                      <p className="font-mono text-xs text-ink-muted">{r.tenantSlug}</p>
                    )}
                  </td>

                  <td className="px-3 py-3">
                    <p className="break-all text-xs text-ink">{r.actorEmail ?? 'sistema'}</p>
                    {r.actorRole && (
                      <p className="text-xs text-ink-muted">{r.actorRole}</p>
                    )}
                  </td>

                  <td className="px-3 py-3">
                    {r.reason && (
                      <p className="text-xs italic text-ink">«{r.reason}»</p>
                    )}
                    {cambio && (
                      <p className={`mt-1 font-mono text-xs text-ink-muted ${expandida ? '' : 'line-clamp-2'}`}>
                        {cambio}
                      </p>
                    )}
                    {!r.reason && !cambio && (
                      <span className="text-xs text-ink-muted">—</span>
                    )}
                    {(cambio || r.ipAddress) && (
                      <button
                        type="button"
                        onClick={() => setAbierta(expandida ? null : r.id)}
                        className="mt-1 text-xs font-semibold text-industrial-700 underline dark:text-industrial-400"
                      >
                        {expandida ? 'Ocultar' : 'Ver más'}
                      </button>
                    )}
                    {expandida && r.ipAddress && (
                      <p className="mt-1 font-mono text-xs text-ink-muted">IP {r.ipAddress}</p>
                    )}
                  </td>
                </tr>
              )
            })}

            {visibles.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-10 text-center text-ink-muted">
                  {rows.length === 0
                    ? 'Sin acciones registradas.'
                    : 'Ninguna acción de esa gravedad.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}
