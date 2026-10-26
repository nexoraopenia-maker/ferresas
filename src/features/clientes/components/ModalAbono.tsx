'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState, useTransition } from 'react'
import { MENSAJE_SIN_RED, useEnLinea } from '@/lib/en-linea'
import { fechaDiaCorta } from '@/lib/fecha-local'
import { cajaAbiertaParaAbonos, registrarAbono } from '@/features/credito/actions'
import { METODOS_ABONO, previsualizarAbono, type CuentaAbonable, type VistaPreviaAbono } from '../abono-ui'

const money = (n: number) => `S/ ${n.toFixed(2)}`
const campo = 'h-touch w-full rounded-xl border border-hairline bg-surface px-3 text-base text-ink'

export interface ResultadoAbono {
  paymentId: string
  monto: number
  deudaDespues: number
  reparto: { venta: string; monto: number; saldoDespues: number; pagada: boolean }[]
}

/**
 * La vista del modal, SIN estado propio: todo llega por props. Así se renderiza en cualquier situación (caja cerrada, abono de más,
 * cuentas elegidas…) y se prueba sin navegador; `ModalAbono` solo le pone el estado y las llamadas al servidor.
 */
export function VistaAbono({
  nombre, cuentas, metodo, texto, referencia, elegirManual, elegidas, cajaAbierta, vista, enviando, errorServidor, resultado, enLinea,
  onMetodo, onTexto, onReferencia, onElegirManual, onAlternarCuenta, onEnviar, onCerrar,
}: {
  nombre: string
  cuentas: readonly CuentaAbonable[]
  metodo: string
  texto: string
  referencia: string
  elegirManual: boolean
  elegidas: readonly string[]
  cajaAbierta: boolean | null
  vista: VistaPreviaAbono
  enviando: boolean
  errorServidor: string | null
  resultado: ResultadoAbono | null
  enLinea: boolean
  onMetodo: (m: string) => void
  onTexto: (t: string) => void
  onReferencia: (t: string) => void
  onElegirManual: (v: boolean) => void
  onAlternarCuenta: (id: string) => void
  onEnviar: () => void
  onCerrar: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-label={`Registrar abono de ${nombre}`} data-modal="abono">
      <div className="absolute inset-0 bg-black/50" onClick={onCerrar} aria-hidden />
      <div className="relative max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-surface p-5 shadow-xl sm:rounded-3xl">
        <h2 className="text-lg font-bold text-ink">Registrar abono</h2>
        <p className="text-sm text-ink-muted">{nombre}</p>

        {resultado ? (
          <div data-abono="hecho" className="mt-4 flex flex-col gap-3">
            <p className="rounded-xl bg-stock-ok-soft px-3 py-2 font-bold text-stock-ok">Abono de {money(resultado.monto)} registrado.</p>
            <ul className="flex flex-col gap-1 text-sm text-ink">
              {resultado.reparto.map((r) => (
                <li key={r.venta} className="flex justify-between gap-2">
                  <span>{r.venta}{r.pagada ? ' · saldada' : ''}</span>
                  <span className="tabular-nums">{money(r.monto)} <span className="text-ink-muted">(queda {money(r.saldoDespues)})</span></span>
                </li>
              ))}
            </ul>
            <p className="font-bold text-ink">Deuda del cliente ahora: {money(resultado.deudaDespues)}</p>
            <a href={`/imprimir/abono/${resultado.paymentId}?auto=1`} target="_blank" rel="noopener" data-enlace="recibo-abono"
              className="flex h-touch items-center justify-center rounded-xl border-2 border-graphite-900 font-bold text-ink dark:border-graphite-50">Imprimir recibo (80 mm)</a>
            <button type="button" onClick={onCerrar} className="h-touch rounded-xl bg-industrial-600 font-bold text-white">Listo</button>
          </div>
        ) : (
          <div className="mt-4 flex flex-col gap-3">
            <div role="group" aria-label="Método" className="grid grid-cols-3 gap-2">
              {METODOS_ABONO.map((m) => (
                <button key={m.value} type="button" aria-pressed={metodo === m.value} onClick={() => onMetodo(m.value)}
                  className={`h-12 rounded-xl text-sm font-bold ${metodo === m.value ? 'bg-industrial-600 text-white' : 'border-2 border-hairline text-ink'}`}>{m.label}</button>
              ))}
            </div>
            {metodo === 'EFECTIVO' && cajaAbierta === false && (
              <p role="alert" data-abono="sin-caja" className="rounded-xl bg-stock-low-soft px-3 py-2 text-sm font-semibold text-stock-low">
                No hay caja abierta en esta sucursal. Un abono en efectivo entra al cajón: abre la caja primero.
              </p>
            )}
            <label className="flex flex-col gap-1 text-sm font-semibold text-ink">Monto (S/)
              <input name="amount" type="text" inputMode="decimal" value={texto} onChange={(e) => onTexto(e.target.value)} placeholder="0.00" autoFocus className={`${campo} text-xl font-bold`} />
            </label>
            <label className="flex flex-col gap-1 text-sm font-semibold text-ink">Referencia (opcional)
              <input name="reference" value={referencia} onChange={(e) => onReferencia(e.target.value)} maxLength={60} placeholder="N.º de operación, voucher…" className={campo} />
            </label>

            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-semibold text-ink">¿A qué cuentas se aplica?</legend>
              <label className="flex items-center gap-2 text-sm text-ink"><input type="radio" name="aplicar" checked={!elegirManual} onChange={() => onElegirManual(false)} className="size-5" />La más antigua primero (recomendado)</label>
              <label className="flex items-center gap-2 text-sm text-ink"><input type="radio" name="aplicar" checked={elegirManual} onChange={() => onElegirManual(true)} className="size-5" />Elegir cuentas</label>
              {elegirManual && (
                <ul data-abono="cuentas" className="flex flex-col gap-1.5">
                  {cuentas.map((x) => {
                    const pos = elegidas.indexOf(x.id)
                    return (
                      <li key={x.id}>
                        <label className="flex items-center gap-2 rounded-xl border border-hairline px-3 py-2 text-sm text-ink">
                          <input type="checkbox" checked={pos >= 0} onChange={() => onAlternarCuenta(x.id)} className="size-5" />
                          <span className="min-w-0 flex-1">{x.venta} · vence {fechaDiaCorta(x.vence)}{x.vencida && <span className="ml-1 font-semibold text-stock-low">vencida</span>}</span>
                          <span className="tabular-nums font-semibold">{money(x.saldo)}</span>
                          {pos >= 0 && <span className="rounded-full bg-industrial-600 px-2 text-xs font-bold text-white" aria-label={`Orden ${pos + 1}`}>{pos + 1}</span>}
                        </label>
                      </li>
                    )
                  })}
                </ul>
              )}
            </fieldset>

            {vista.partes.length > 0 && (
              <section data-abono="vista-previa" aria-label="Vista previa" className="rounded-xl bg-surface-sunken px-3 py-2 text-sm">
                <p className="font-semibold text-ink">Así se aplicará:</p>
                <ul className="mt-1 flex flex-col gap-0.5">
                  {vista.partes.map((p) => (
                    <li key={p.id} className="flex justify-between gap-2 text-ink">
                      <span>{p.venta}{p.pagada ? ' · queda saldada' : ''}</span>
                      <span className="tabular-nums">{money(p.monto)} <span className="text-ink-muted">(queda {money(p.saldoDespues)})</span></span>
                    </li>
                  ))}
                </ul>
                {vista.deudaDespues !== null && <p data-abono="deuda-despues" className="mt-1 font-bold text-ink">Deuda del cliente después: {money(vista.deudaDespues)}</p>}
              </section>
            )}

            {vista.error && <p role="alert" data-abono="error" className="rounded-xl bg-stock-out-soft px-3 py-2 text-sm font-semibold text-stock-out">{vista.error}</p>}
            {errorServidor && <p role="alert" data-abono="error-servidor" className="rounded-xl bg-stock-out-soft px-3 py-2 text-sm font-semibold text-stock-out">{errorServidor}</p>}
            {!enLinea && <p role="alert" data-abono="sin-red" className="text-sm font-semibold text-stock-low">{MENSAJE_SIN_RED}</p>}

            <div className="flex gap-2">
              <button type="button" data-boton="registrar-abono" onClick={onEnviar} disabled={!vista.listo || enviando || !enLinea}
                className="h-touch flex-1 rounded-xl bg-industrial-600 font-bold text-white disabled:opacity-40">
                {enviando ? 'Registrando…' : vista.monto && vista.listo ? `Cobrar ${money(vista.monto)}` : 'Cobrar'}
              </button>
              <button type="button" onClick={onCerrar} className="h-touch rounded-xl border border-hairline px-4 font-semibold text-ink">Cancelar</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Modal de abono con estado. La clave de idempotencia nace al abrir y se conserva en los reintentos (un corte de red no cobra dos
 * veces); se renueva solo tras un abono hecho o al reabrir.
 */
export function ModalAbono({ abierto, onCerrar, customerId, nombre, cuentas, deudaTotal }: {
  abierto: boolean
  onCerrar: () => void
  customerId: string
  nombre: string
  cuentas: readonly CuentaAbonable[]
  deudaTotal: number
}) {
  const router = useRouter()
  const enLinea = useEnLinea()
  const [pendiente, startTransition] = useTransition()
  const clave = useRef<string | null>(null)
  const [metodo, setMetodo] = useState('EFECTIVO')
  const [texto, setTexto] = useState('')
  const [referencia, setReferencia] = useState('')
  const [elegirManual, setElegirManual] = useState(false)
  const [elegidas, setElegidas] = useState<string[]>([])
  const [cajaAbierta, setCajaAbierta] = useState<boolean | null>(null)
  const [errorServidor, setErrorServidor] = useState<string | null>(null)
  const [resultado, setResultado] = useState<ResultadoAbono | null>(null)

  useEffect(() => {
    if (!abierto) return
    clave.current = crypto.randomUUID()
    setTexto(''); setReferencia(''); setElegirManual(false); setElegidas([]); setErrorServidor(null); setResultado(null); setMetodo('EFECTIVO')
    let vigente = true
    void cajaAbiertaParaAbonos().then((r) => { if (vigente) setCajaAbierta(r.ok ? r.data.abierta : null) })
    return () => { vigente = false }
  }, [abierto])

  if (!abierto) return null

  const vista = previsualizarAbono({ cuentas, elegidas: elegirManual ? elegidas : null, texto, metodo, cajaAbierta, deudaTotal })

  const enviar = () => {
    if (!enLinea) { setErrorServidor(MENSAJE_SIN_RED); return }
    if (!vista.listo || vista.monto === null) return
    setErrorServidor(null)
    startTransition(async () => {
      const r = await registrarAbono({
        customerId, method: metodo, amount: vista.monto, ...(referencia.trim() ? { reference: referencia.trim() } : {}),
        ...(elegirManual ? { receivableIds: elegidas } : {}), idempotencyKey: clave.current,
      })
      if (!r.ok) { setErrorServidor(r.message); return }
      clave.current = crypto.randomUUID()
      setResultado({ paymentId: r.data.paymentId, monto: r.data.monto, deudaDespues: r.data.deudaDespues, reparto: r.data.reparto.map((x) => ({ venta: x.venta, monto: x.monto, saldoDespues: x.saldoDespues, pagada: x.pagada })) })
    })
  }

  const cerrar = () => { if (resultado) router.refresh(); onCerrar() }

  return (
    <VistaAbono
      nombre={nombre} cuentas={cuentas} metodo={metodo} texto={texto} referencia={referencia} elegirManual={elegirManual} elegidas={elegidas}
      cajaAbierta={cajaAbierta} vista={vista} enviando={pendiente} errorServidor={errorServidor} resultado={resultado} enLinea={enLinea}
      onMetodo={setMetodo} onTexto={setTexto} onReferencia={setReferencia}
      onElegirManual={(v) => { setElegirManual(v); if (!v) setElegidas([]) }}
      onAlternarCuenta={(id) => setElegidas((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))}
      onEnviar={enviar} onCerrar={cerrar}
    />
  )
}
