import { fechaDiaCorta } from '@/lib/fecha-local'
import type { InfoCreditoCliente } from '@/features/credito/reglas'

const money = (n: number) => `S/ ${n.toFixed(2)}`

/**
 * La ficha de crédito del cliente asignado a la venta: línea, deuda, disponible y plazo. Solo presenta datos que ya trae la ficha;
 * las reglas (si se puede fiar y por qué no) las decide `reglas.ts`, la misma que usa el servidor.
 *
 * La deuda vencida es un AVISO naranja, no un bloqueo: el único bloqueo duro es la línea.
 */
export function FichaCredito({ ficha, cargando = false, falla = null }: {
  ficha: InfoCreditoCliente | null
  cargando?: boolean
  /** La consulta falló (sin red, sin permiso…): se dice, no se inventa una ficha. */
  falla?: string | null
}) {
  if (falla) {
    return <p role="status" data-ficha="falla" className="rounded-xl border border-hairline bg-surface-sunken px-3 py-2 text-xs text-ink-muted">{falla}</p>
  }
  if (!ficha) {
    return cargando
      ? <p role="status" data-ficha="cargando" className="rounded-xl border border-hairline bg-surface-sunken px-3 py-2 text-xs text-ink-muted">Consultando el crédito del cliente…</p>
      : null
  }
  const sinLinea = ficha.limite <= 0
  return (
    <section aria-label="Crédito del cliente" data-ficha="ok" className="rounded-xl border border-hairline bg-surface px-3 py-2 text-sm">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Crédito</h3>
      {sinLinea ? (
        <p className="mt-0.5 text-ink-muted">Sin línea de crédito.</p>
      ) : (
        <dl className="mt-1 grid grid-cols-3 gap-2">
          <div><dt className="text-xs text-ink-muted">Línea</dt><dd className="font-bold tabular-nums text-ink">{money(ficha.limite)}</dd></div>
          <div><dt className="text-xs text-ink-muted">Debe</dt><dd className="font-bold tabular-nums text-ink">{money(ficha.deuda)}</dd></div>
          <div><dt className="text-xs text-ink-muted">Disponible</dt><dd className="font-bold tabular-nums text-ink">{money(ficha.disponible)}</dd></div>
        </dl>
      )}
      {ficha.puedeFiar
        ? <p className="mt-1 text-xs text-ink-muted">Si se fía hoy, vence el {fechaDiaCorta(ficha.venceSiFia)} ({ficha.plazoDias} {ficha.plazoDias === 1 ? 'día' : 'días'}).</p>
        : <p role="alert" data-ficha="no-fia" className="mt-1 text-xs font-semibold text-stock-out">No se puede fiar: {ficha.motivo}</p>}
      {ficha.vencido > 0 && (
        <p role="alert" data-ficha="mora" className="mt-1 rounded-lg border border-stock-low/40 bg-stock-low-soft px-2 py-1 text-xs font-semibold text-stock-low">
          Deuda vencida: {money(ficha.vencido)} en {ficha.cuentasVencidas} {ficha.cuentasVencidas === 1 ? 'cuenta' : 'cuentas'}. Puedes cobrar, pero conviene pedirle que se ponga al día.
        </p>
      )}
    </section>
  )
}
