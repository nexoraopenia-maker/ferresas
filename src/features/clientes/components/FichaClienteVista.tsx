import { fechaDiaCorta } from '@/lib/fecha-local'
import type { CuentaAbonable } from '../abono-ui'
import type { FichaCliente } from '../service'
import { AccionesCliente } from './AccionesCliente'
import { ConfigCredito } from './ConfigCredito'
import { CuentasYAbonos } from './CuentasYAbonos'
import { FormularioCliente } from './FormularioCliente'

const money = (n: number) => `S/ ${n.toFixed(2)}`

export interface PermisosFicha {
  /** `clientes.gestionar`: editar datos, dar de baja, reactivar. */
  puedeGestionar: boolean
  /** `credito.cobrar`: registrar abonos. */
  puedeAbonar: boolean
  /** `credito.limite`: línea, plazo y bloqueo. */
  puedeLimite: boolean
  /** `credito.castigar`: dar de baja deudas, anular abonos, resolver revisiones. */
  puedeCastigar: boolean
  /** La cuenta del negocio permite escribir (no está en solo lectura). */
  puedeOperar: boolean
}

/** Las cuentas abiertas como las ve el modal de abonos: en el MISMO orden en que el servidor las aplicaría. */
export function cuentasAbonables(f: Pick<FichaCliente, 'cuentasAbiertas'>): CuentaAbonable[] {
  return f.cuentasAbiertas.map((x) => ({ id: x.id, venta: x.venta, saldo: x.saldo, vence: x.vence, vencida: x.vencida }))
}

/**
 * La ficha del cliente: cabecera con acciones, resumen de deuda, datos, crédito, cuentas y abonos. Compone; cada bloque decide solo
 * según los permisos que recibe (resueltos en el servidor). Ocultar un botón es comodidad: el servicio vuelve a decidir.
 */
export function FichaClienteVista({ ficha, permisos }: { ficha: FichaCliente; permisos: PermisosFicha }) {
  const c = ficha.credito
  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">{ficha.name}</h1>
          <p className="text-sm text-ink-muted">
            {ficha.docNumber ? `${ficha.docType} ${ficha.docNumber}` : 'Sin documento'}{ficha.phone ? ` · ${ficha.phone}` : ''} · cliente desde {fechaDiaCorta(ficha.creado.slice(0, 10))}
          </p>
          {!ficha.activo && <p data-aviso="de-baja" className="mt-1 rounded-lg bg-surface-sunken px-2 py-1 text-sm font-semibold text-ink-muted">Cliente dado de baja: no aparece en el POS ni en las listas.</p>}
        </div>
        <AccionesCliente
          customerId={ficha.id} nombre={ficha.name} activo={ficha.activo} deudaTotal={c.deuda} cuentas={cuentasAbonables(ficha)}
          puedeAbonar={permisos.puedeAbonar} puedeGestionar={permisos.puedeGestionar} puedeOperar={permisos.puedeOperar}
        />
      </header>

      <section aria-label="Resumen de crédito" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Dato k="Debe" v={money(c.deuda)} fuerte />
        <Dato k="Línea" v={c.limite > 0 ? money(c.limite) : 'Sin línea'} />
        <Dato k="Disponible" v={c.limite > 0 ? money(c.disponible) : '—'} />
        <Dato k="Vencido" v={money(c.vencido)} alerta={c.vencido > 0} />
      </section>
      {c.bloqueado && <p data-aviso="bloqueado" className="rounded-xl bg-stock-out-soft px-3 py-2 text-sm font-semibold text-stock-out">El crédito de este cliente está bloqueado: no se le puede fiar.</p>}
      {c.vencido > 0 && (
        <p data-aviso="mora" className="rounded-xl bg-stock-low-soft px-3 py-2 text-sm font-semibold text-stock-low">
          Tiene {money(c.vencido)} vencidos en {c.cuentasVencidas} {c.cuentasVencidas === 1 ? 'cuenta' : 'cuentas'}.
        </p>
      )}

      {permisos.puedeGestionar && ficha.activo ? (
        <FormularioCliente
          modo="editar" documentoEditable={ficha.documentoEditable}
          inicial={{ id: ficha.id, name: ficha.name, docNumber: ficha.docNumber, phone: ficha.phone, email: ficha.email, address: ficha.address, notes: ficha.notes }}
        />
      ) : (
        <section aria-label="Datos" data-seccion="datos-lectura" className="rounded-2xl border border-hairline bg-surface p-4 text-sm text-ink">
          <h3 className="font-bold">Datos del cliente</h3>
          <dl className="mt-2 grid gap-1 sm:grid-cols-2">
            <div><dt className="text-xs text-ink-muted">Teléfono</dt><dd>{ficha.phone ?? '—'}</dd></div>
            <div><dt className="text-xs text-ink-muted">Correo</dt><dd>{ficha.email ?? '—'}</dd></div>
            <div className="sm:col-span-2"><dt className="text-xs text-ink-muted">Dirección</dt><dd>{ficha.address ?? '—'}</dd></div>
            {ficha.notes && <div className="sm:col-span-2"><dt className="text-xs text-ink-muted">Notas</dt><dd>{ficha.notes}</dd></div>}
          </dl>
        </section>
      )}

      <ConfigCredito
        customerId={ficha.id} limite={c.limite} plazoDias={c.plazoDias} bloqueado={c.bloqueado}
        documentoValido={c.documentoValido} puedeEditar={permisos.puedeLimite && permisos.puedeOperar && ficha.activo}
      />

      <CuentasYAbonos
        abiertas={ficha.cuentasAbiertas} cerradas={ficha.cuentasCerradas} abonos={ficha.abonos}
        puedeCastigar={permisos.puedeCastigar} puedeOperar={permisos.puedeOperar}
      />
    </div>
  )
}

function Dato({ k, v, fuerte, alerta }: { k: string; v: string; fuerte?: boolean; alerta?: boolean }) {
  return (
    <div className={`rounded-2xl border px-3 py-2 ${alerta ? 'border-stock-low/40 bg-stock-low-soft' : 'border-hairline bg-surface'}`}>
      <p className="text-xs text-ink-muted">{k}</p>
      <p className={`tabular-nums ${fuerte ? 'text-xl font-extrabold' : 'text-lg font-bold'} ${alerta ? 'text-stock-low' : 'text-ink'}`}>{v}</p>
    </div>
  )
}
