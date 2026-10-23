'use client'

import { useRef, useState, useTransition } from 'react'
import Link from 'next/link'
import { unitLabel } from '@/lib/quantity'
import { buscarProductosGuiaAction, emitirGuiaAction } from '../actions'
import type { BorradorGuia, LineaBorrador } from '../service'
import { ETIQUETA_DOC, MODALIDADES, MOTIVOS, TIPOS_DOC_CONDUCTOR, TIPOS_DOC_DESTINATARIO } from '../reglas'

const campo =
  'h-touch-lg w-full rounded-xl border border-hairline bg-surface px-4 text-base text-ink placeholder:text-ink-muted focus:border-industrial-600 focus:outline-none focus:ring-2 focus:ring-industrial-600/40'
const tarjeta = 'rounded-2xl border border-hairline bg-surface p-4'

/** A nivel de módulo a propósito: definido dentro del formulario, React lo desmontaría en cada tecla y el campo perdería el foco. */
function Campo({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm font-medium text-ink-muted">{label}</span>
      {children}
      {error && <span className="text-xs font-semibold text-stock-out">{error}</span>}
    </label>
  )
}

type Sugerencia = { productId: string; name: string; sku: string; unitType: string }

/**
 * Formulario de la Guía de Remisión (remitente). Precarga lo que sabe de la venta
 * o la transferencia (destinatario, direcciones, líneas pendientes) y deja
 * completar lo que solo sabe quien despacha: peso, transporte, vehículo y conductor.
 * El servidor vuelve a validar TODO; aquí solo se marcan los errores por campo.
 */
export function GuiaForm({ borrador, hoy }: { borrador: BorradorGuia; hoy: string }) {
  const [pending, start] = useTransition()
  const [errores, setErrores] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [emitida, setEmitida] = useState<string | null>(null)

  const [motive, setMotive] = useState(borrador.motive)
  const [motiveDetail, setMotiveDetail] = useState('')
  const [modo, setModo] = useState<'PUBLICO' | 'PRIVADO'>('PRIVADO')
  const [inicio, setInicio] = useState(hoy)
  const [peso, setPeso] = useState('')
  const [bultos, setBultos] = useState('')
  const [rDocType, setRDocType] = useState<string>(borrador.recipient.docType || 'RUC')
  const [rDoc, setRDoc] = useState(borrador.recipient.docNumber)
  const [rNombre, setRNombre] = useState(borrador.recipient.name)
  const [oDir, setODir] = useState(borrador.origin.address)
  const [oUbi, setOUbi] = useState(borrador.origin.ubigeo)
  const [dDir, setDDir] = useState(borrador.destination.address)
  const [dUbi, setDUbi] = useState(borrador.destination.ubigeo)
  const [cRuc, setCRuc] = useState('')
  const [cNombre, setCNombre] = useState('')
  const [placa, setPlaca] = useState('')
  const [chTipo, setChTipo] = useState<string>('DNI')
  const [chDoc, setChDoc] = useState('')
  const [chNombre, setChNombre] = useState('')
  const [chLic, setChLic] = useState('')
  const [notas, setNotas] = useState('')
  const [lineas, setLineas] = useState<LineaBorrador[]>(borrador.items)

  const [busqueda, setBusqueda] = useState('')
  const [sugerencias, setSugerencias] = useState<Sugerencia[]>([])
  const temporizador = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const err = (k: string) => errores[k]

  const buscar = (texto: string) => {
    setBusqueda(texto)
    clearTimeout(temporizador.current)
    if (texto.trim().length < 2) { setSugerencias([]); return }
    temporizador.current = setTimeout(async () => {
      const r = await buscarProductosGuiaAction(texto)
      setSugerencias(r.ok ? r.data : [])
    }, 200)
  }
  const agregar = (p: Sugerencia) => {
    setLineas((prev) => prev.some((l) => l.productId === p.productId) ? prev
      : [...prev, { productId: p.productId, name: p.name, sku: p.sku, unitType: p.unitType, quantity: 1, max: null }])
    setBusqueda(''); setSugerencias([])
  }

  const emitir = () => {
    setError(null); setErrores({})
    const n = (t: string) => (t.trim() === '' ? undefined : Number(t.replace(',', '.')))
    start(async () => {
      const r = await emitirGuiaAction({
        saleId: borrador.saleId, transferId: borrador.transferId,
        motive, motiveDetail: motive === 'OTROS' ? motiveDetail : undefined, transportMode: modo,
        transferStartDate: inicio, grossWeightKg: n(peso), packages: n(bultos),
        recipient: { docType: rDocType, docNumber: rDoc, name: rNombre },
        origin: { address: oDir, ubigeo: oUbi }, destination: { address: dDir, ubigeo: dUbi },
        ...(modo === 'PUBLICO'
          ? { carrier: { ruc: cRuc, name: cNombre } }
          : { vehicle: { plate: placa }, driver: { docType: chTipo, docNumber: chDoc, name: chNombre, license: chLic } }),
        notes: notas || undefined,
        items: lineas.map((l) => ({ productId: l.productId, quantity: l.quantity })),
      })
      if (!r.ok) {
        if (r.code === 'VALIDATION' && r.details) setErrores(r.details as Record<string, string>)
        setError(r.message)
        return
      }
      setEmitida(r.data.fullNumber)
    })
  }

  if (emitida) {
    return (
      <section className={`${tarjeta} flex flex-col gap-3`} role="status">
        <p className="text-lg font-bold text-ink">Guía {emitida} emitida</p>
        <p className="text-sm text-ink-muted">
          Quedó registrada y numerada. Todavía no se transmite a SUNAT (falta conectar un proveedor): figura como pendiente.
        </p>
        <Link href="/guias" className="h-touch-lg inline-flex items-center justify-center rounded-xl bg-industrial-600 px-5 font-bold text-white">Ver guías</Link>
      </section>
    )
  }

  const marca = (k: string) => (err(k) ? ' border-stock-out' : '')

  return (
    <div className="flex flex-col gap-4">
      {borrador.etiquetaOrigen && (
        <p className="rounded-xl bg-industrial-600/10 px-4 py-2 text-sm font-semibold text-ink">Vinculada a: {borrador.etiquetaOrigen}</p>
      )}

      <section className={`${tarjeta} grid gap-3 sm:grid-cols-2`}>
        <h2 className="font-bold text-ink sm:col-span-2">Traslado</h2>
        <Campo label="Motivo del traslado" error={err('saleId')}>
          <select value={motive} onChange={(e) => setMotive(e.target.value as typeof motive)} className={campo}>
            {Object.entries(MOTIVOS).map(([k, v]) => <option key={k} value={k}>{v.etiqueta}</option>)}
          </select>
        </Campo>
        {motive === 'OTROS' && (
          <Campo label="Detalle del motivo" error={err('motiveDetail')}>
            <input value={motiveDetail} onChange={(e) => setMotiveDetail(e.target.value)} className={campo + marca('motiveDetail')} />
          </Campo>
        )}
        <Campo label="Fecha de inicio del traslado" error={err('transferStartDate')}>
          <input type="date" value={inicio} min={hoy} onChange={(e) => setInicio(e.target.value)} className={campo + marca('transferStartDate')} />
        </Campo>
        <Campo label="Peso bruto total (kg)" error={err('grossWeightKg')}>
          <input inputMode="decimal" value={peso} onChange={(e) => setPeso(e.target.value)} placeholder="0.000" className={campo + marca('grossWeightKg')} />
        </Campo>
        <Campo label="Número de bultos (opcional)" error={err('packages')}>
          <input inputMode="numeric" value={bultos} onChange={(e) => setBultos(e.target.value)} className={campo + marca('packages')} />
        </Campo>
      </section>

      <section className={`${tarjeta} grid gap-3 sm:grid-cols-2`}>
        <h2 className="font-bold text-ink sm:col-span-2">Destinatario</h2>
        <Campo label="Tipo de documento">
          <select value={rDocType} onChange={(e) => setRDocType(e.target.value)} className={campo}>
            {TIPOS_DOC_DESTINATARIO.map((t) => <option key={t} value={t}>{ETIQUETA_DOC[t]}</option>)}
          </select>
        </Campo>
        <Campo label="Número de documento" error={err('recipient.docNumber')}>
          <input value={rDoc} onChange={(e) => setRDoc(e.target.value)} inputMode="numeric" className={campo + marca('recipient.docNumber')} />
        </Campo>
        <div className="sm:col-span-2">
          <Campo label="Nombre o razón social" error={err('recipient.name')}>
            <input value={rNombre} onChange={(e) => setRNombre(e.target.value)} className={campo + marca('recipient.name')} />
          </Campo>
        </div>
      </section>

      <section className={`${tarjeta} grid gap-3 sm:grid-cols-[1fr_9rem]`}>
        <h2 className="font-bold text-ink sm:col-span-2">Punto de partida y de llegada</h2>
        <Campo label="Dirección de partida (completa)" error={err('origin.address')}>
          <input value={oDir} onChange={(e) => setODir(e.target.value)} className={campo + marca('origin.address')} />
        </Campo>
        <Campo label="Ubigeo (6 dígitos)" error={err('origin.ubigeo')}>
          <input value={oUbi} onChange={(e) => setOUbi(e.target.value)} inputMode="numeric" maxLength={6} className={campo + marca('origin.ubigeo')} />
        </Campo>
        <Campo label="Dirección de llegada (completa)" error={err('destination.address')}>
          <input value={dDir} onChange={(e) => setDDir(e.target.value)} className={campo + marca('destination.address')} />
        </Campo>
        <Campo label="Ubigeo (6 dígitos)" error={err('destination.ubigeo')}>
          <input value={dUbi} onChange={(e) => setDUbi(e.target.value)} inputMode="numeric" maxLength={6} className={campo + marca('destination.ubigeo')} />
        </Campo>
      </section>

      <section className={`${tarjeta} grid gap-3 sm:grid-cols-2`}>
        <h2 className="font-bold text-ink sm:col-span-2">Transporte</h2>
        <div role="group" aria-label="Modalidad de transporte" className="grid gap-2 sm:col-span-2 sm:grid-cols-2">
          {(Object.keys(MODALIDADES) as Array<keyof typeof MODALIDADES>).map((m) => (
            <button key={m} type="button" aria-pressed={modo === m} onClick={() => setModo(m)}
              className={`min-h-touch-lg rounded-xl border-2 px-3 py-2 text-left text-sm font-semibold ${modo === m ? 'border-industrial-600 bg-industrial-600/10 text-ink' : 'border-hairline text-ink-muted'}`}>
              {MODALIDADES[m].etiqueta}
            </button>
          ))}
        </div>
        {modo === 'PUBLICO' ? (
          <>
            <Campo label="RUC del transportista" error={err('carrier.ruc')}>
              <input value={cRuc} onChange={(e) => setCRuc(e.target.value)} inputMode="numeric" maxLength={11} className={campo + marca('carrier.ruc')} />
            </Campo>
            <Campo label="Razón social del transportista" error={err('carrier.name')}>
              <input value={cNombre} onChange={(e) => setCNombre(e.target.value)} className={campo + marca('carrier.name')} />
            </Campo>
          </>
        ) : (
          <>
            <Campo label="Placa del vehículo" error={err('vehicle.plate')}>
              <input value={placa} onChange={(e) => setPlaca(e.target.value.toUpperCase())} placeholder="ABC123" className={campo + marca('vehicle.plate')} />
            </Campo>
            <Campo label="Licencia de conducir" error={err('driver.license')}>
              <input value={chLic} onChange={(e) => setChLic(e.target.value.toUpperCase())} className={campo + marca('driver.license')} />
            </Campo>
            <Campo label="Documento del conductor">
              <select value={chTipo} onChange={(e) => setChTipo(e.target.value)} className={campo}>
                {TIPOS_DOC_CONDUCTOR.map((t) => <option key={t} value={t}>{ETIQUETA_DOC[t]}</option>)}
              </select>
            </Campo>
            <Campo label="Número de documento del conductor" error={err('driver.docNumber')}>
              <input value={chDoc} onChange={(e) => setChDoc(e.target.value)} inputMode="numeric" className={campo + marca('driver.docNumber')} />
            </Campo>
            <div className="sm:col-span-2">
              <Campo label="Nombres y apellidos del conductor" error={err('driver.name')}>
                <input value={chNombre} onChange={(e) => setChNombre(e.target.value)} className={campo + marca('driver.name')} />
              </Campo>
            </div>
          </>
        )}
      </section>

      <section className={`${tarjeta} flex flex-col gap-3`}>
        <h2 className="font-bold text-ink">Productos a trasladar</h2>
        {err('items') && <p className="text-xs font-semibold text-stock-out">{err('items')}</p>}
        {lineas.length === 0 && <p className="text-sm text-ink-muted">Todavía no hay productos. Búscalos abajo.</p>}
        <ul className="flex flex-col gap-2">
          {lineas.map((l, i) => (
            <li key={l.productId} className="flex items-center gap-3 rounded-xl border border-hairline p-3">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold text-ink">{l.name}</span>
                <span className="block text-xs text-ink-muted">{l.sku}{l.max !== null ? ` · pendiente ${l.max}` : ''}</span>
              </span>
              <input
                aria-label={`Cantidad de ${l.name}`} inputMode="decimal" value={String(l.quantity)}
                onChange={(e) => { const v = Number(e.target.value.replace(',', '.')); setLineas((p) => p.map((x, j) => j === i ? { ...x, quantity: Number.isFinite(v) ? v : 0 } : x)) }}
                className="h-touch w-24 rounded-lg border border-hairline bg-surface px-2 text-right font-bold text-ink"
              />
              <span className="w-10 text-xs text-ink-muted">{unitLabel(l.unitType)}</span>
              <button type="button" onClick={() => setLineas((p) => p.filter((_, j) => j !== i))} className="h-touch rounded-lg px-3 text-sm font-semibold text-stock-out">Quitar</button>
            </li>
          ))}
        </ul>
        <div className="relative">
          <input value={busqueda} onChange={(e) => buscar(e.target.value)} placeholder="Añadir otro producto…" autoComplete="off" className={campo} />
          {sugerencias.length > 0 && (
            <ul className="absolute inset-x-0 top-full z-10 mt-1 max-h-60 overflow-y-auto rounded-xl border border-hairline bg-surface shadow-xl">
              {sugerencias.map((s) => (
                <li key={s.productId}>
                  <button type="button" onClick={() => agregar(s)} className="w-full px-4 py-3 text-left hover:bg-surface-sunken">
                    <span className="block font-semibold text-ink">{s.name}</span>
                    <span className="block text-xs text-ink-muted">{s.sku}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <Campo label="Observaciones (opcional)">
          <input value={notas} onChange={(e) => setNotas(e.target.value)} maxLength={300} className={campo} />
        </Campo>
      </section>

      {error && <p role="alert" className="rounded-xl bg-stock-out-soft px-4 py-3 text-sm font-semibold text-stock-out">{error}</p>}

      <button type="button" onClick={emitir} disabled={pending || lineas.length === 0}
        className="h-16 rounded-2xl bg-industrial-600 text-lg font-bold text-white shadow-md transition active:scale-95 disabled:opacity-40">
        {pending ? 'Emitiendo…' : 'Emitir guía de remisión'}
      </button>
    </div>
  )
}
