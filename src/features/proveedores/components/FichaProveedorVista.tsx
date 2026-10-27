import Link from 'next/link'
import { fechaDiaCorta } from '@/lib/fecha-local'
import type { FilaCompra } from '@/features/compras/service'
import type { PagoDeProveedor } from '@/features/por-pagar/informes'
import { PagosDelProveedor } from '@/features/por-pagar/components/PagosDelProveedor'
import { ETIQUETA_CONDICION, ETIQUETA_ESTADO } from '@/features/compras/borrador-ui'
import type { FichaProveedor } from '../service'
import { AccionesProveedor } from './AccionesProveedor'
import { FormularioProveedor } from './FormularioProveedor'

const money = (n: number) => `S/ ${n.toFixed(2)}`

export interface PermisosFichaProveedor {
  /** `proveedores.gestionar`: editar datos, dar de baja, reactivar. */
  puedeGestionar: boolean
  /** `compras.registrar`: registrar una compra a este proveedor. */
  puedeComprar: boolean
  /** `proveedores.pagar`: registrar y anular pagos. */
  puedePagar: boolean
  /** Ve las cuentas por pagar (pagos, estado de cuenta). */
  puedeVerDeuda: boolean
  /** La cuenta del negocio permite escribir (no está en solo lectura). */
  puedeOperar: boolean
}

/**
 * Ficha del proveedor: cabecera con acciones, lo que se le debe, sus cuentas abiertas, sus últimas compras y sus datos. Compone; cada
 * bloque decide solo según los permisos que recibe (resueltos en el servidor). `pagos` es `null` para quien no ve las cuentas por pagar.
 */
export function FichaProveedorVista({ ficha, compras, pagos, permisos }: { ficha: FichaProveedor; compras: readonly FilaCompra[]; pagos: readonly PagoDeProveedor[] | null; permisos: PermisosFichaProveedor }) {
  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">{ficha.name}</h1>
          <p className="text-sm text-ink-muted">
            {ficha.taxId ? `RUC ${ficha.taxId}` : 'Sin RUC'}{ficha.contact ? ` · ${ficha.contact}` : ''}{ficha.phone ? ` · ${ficha.phone}` : ''} · proveedor desde {fechaDiaCorta(ficha.creado.slice(0, 10))}
          </p>
          {!ficha.activo && <p data-aviso="de-baja" className="mt-1 rounded-lg bg-surface-sunken px-2 py-1 text-sm font-semibold text-ink-muted">Proveedor dado de baja: no aparece en las listas ni al registrar compras.</p>}
        </div>
        <AccionesProveedor
          supplierId={ficha.id} nombre={ficha.name} activo={ficha.activo} deuda={ficha.deuda}
          cuentas={ficha.cuentasAbiertas.map((c) => ({ id: c.id, compra: c.compra, saldo: c.saldo, vence: c.vence, vencida: c.vencida }))}
          puedePagar={permisos.puedePagar} puedeVerDeuda={permisos.puedeVerDeuda}
          puedeGestionar={permisos.puedeGestionar} puedeComprar={permisos.puedeComprar} puedeOperar={permisos.puedeOperar}
        />
      </header>

      <section aria-label="Resumen" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Dato k="Le debes" v={money(ficha.deuda)} fuerte />
        <Dato k="Vencido" v={money(ficha.vencido)} alerta={ficha.vencido > 0} />
        <Dato k="Plazo" v={ficha.paymentTermDays > 0 ? `${ficha.paymentTermDays} días` : 'Sin plazo'} />
        <Dato k="Compras" v={String(ficha.comprasTotal)} />
      </section>
      {ficha.vencido > 0 && (
        <p data-aviso="vencido" className="rounded-xl bg-stock-low-soft px-3 py-2 text-sm font-semibold text-stock-low">
          Tienes {money(ficha.vencido)} vencidos con este proveedor en {ficha.cuentasVencidas} {ficha.cuentasVencidas === 1 ? 'cuenta' : 'cuentas'}.
        </p>
      )}

      <section aria-label="Cuentas por pagar" className="flex flex-col gap-2">
        <h2 className="text-lg font-bold text-ink">Cuentas por pagar</h2>
        {ficha.cuentasAbiertas.length === 0 ? (
          <p data-lista="sin-cuentas" className="text-sm text-ink-muted">No le debes nada a este proveedor.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {ficha.cuentasAbiertas.map((c) => (
              <li key={c.id} data-cuenta={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-hairline bg-surface px-4 py-3">
                <div>
                  <p className="font-semibold text-ink">{c.compra}</p>
                  <p className={`text-xs ${c.vencida ? 'font-semibold text-stock-low' : 'text-ink-muted'}`}>{c.vencida ? 'Venció' : 'Vence'} el {fechaDiaCorta(c.vence)}</p>
                </div>
                <p className="text-right text-sm tabular-nums"><b className="text-ink">{money(c.saldo)}</b>{c.pagado > 0 && <span className="block text-xs text-ink-muted">de {money(c.monto)}</span>}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {pagos && <PagosDelProveedor pagos={pagos} puedePagar={permisos.puedePagar} puedeOperar={permisos.puedeOperar} />}

      <section aria-label="Últimas compras" className="flex flex-col gap-2">
        <h2 className="text-lg font-bold text-ink">Últimas compras</h2>
        {compras.length === 0 ? (
          <p data-lista="sin-compras" className="text-sm text-ink-muted">Todavía no hay compras a este proveedor.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {compras.map((c) => (
              <li key={c.id}>
                <Link href={`/compras/${c.id}`} data-compra={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-hairline bg-surface px-4 py-3 hover:bg-surface-sunken">
                  <div>
                    <p className="font-semibold text-ink">{c.number}{c.invoiceRef ? ` · ${c.invoiceRef}` : ''}</p>
                    <p className="text-xs text-ink-muted">{ETIQUETA_ESTADO[c.status]} · {ETIQUETA_CONDICION[c.paymentCondition]}</p>
                  </div>
                  <p className="font-bold tabular-nums text-ink">{money(c.total)}</p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {permisos.puedeGestionar && ficha.activo ? (
        <FormularioProveedor modo="editar" inicial={ficha} rucEditable={ficha.rucEditable} />
      ) : (
        <section aria-label="Datos" className="rounded-2xl border border-hairline bg-surface p-4 text-sm text-ink">
          <h2 className="mb-2 font-bold">Datos</h2>
          <dl className="grid gap-1 sm:grid-cols-2">
            {([['Correo', ficha.email], ['Dirección', ficha.address], ['Notas', ficha.notes]] as const).map(([k, v]) => (
              <div key={k}><dt className="text-xs text-ink-muted">{k}</dt><dd>{v || '—'}</dd></div>
            ))}
          </dl>
        </section>
      )}
    </div>
  )
}

function Dato({ k, v, fuerte, alerta }: { k: string; v: string; fuerte?: boolean; alerta?: boolean }) {
  return (
    <div className="rounded-2xl border border-hairline bg-surface px-3 py-2">
      <p className="text-xs text-ink-muted">{k}</p>
      <p className={`tabular-nums ${fuerte ? 'text-lg font-bold' : 'font-semibold'} ${alerta ? 'text-stock-low' : 'text-ink'}`}>{v}</p>
    </div>
  )
}
