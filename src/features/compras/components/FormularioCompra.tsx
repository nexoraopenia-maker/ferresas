'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { MENSAJE_SIN_RED, useEnLinea } from '@/lib/en-linea'
import { buscarProductosCompra, crearBorrador, editarBorrador } from '../actions'
import type { BorradorParaEditar, OpcionesCompra, ProductoParaCompra } from '../service'
import { ETIQUETA_CONDICION, motivoNoGuardable, resumenBorrador, venceSugerido, type CondicionCompra } from '../borrador-ui'

const money = (n: number) => `S/ ${n.toFixed(2)}`
const campo = 'h-touch w-full rounded-xl border border-hairline bg-surface px-3 text-base text-ink disabled:bg-surface-sunken disabled:text-ink-muted'

export interface LineaFormulario {
  key: string
  producto: ProductoParaCompra
  /** '' = en unidad base. */
  presentationId: string
  cantidad: string
  costo: string
}

/** La unidad en la que se teclea la línea: la presentación elegida o la unidad base del producto. */
export function unidadDeLinea(l: Pick<LineaFormulario, 'producto' | 'presentationId'>): string {
  const p = l.producto.presentaciones.find((x) => x.id === l.presentationId)
  return p ? `${p.name} (${p.factor} ${l.producto.unitType.toLowerCase()})` : l.producto.unitType.toLowerCase()
}

let secuencia = 0
const nuevaClave = () => `l${++secuencia}`

/**
 * Formulario de una compra (alta o edición de un BORRADOR). Guarda el borrador; recibir la mercadería es un paso aparte, en el detalle,
 * porque mueve stock, costos y deuda. Los totales que se ven salen de las MISMAS funciones con las que el servidor guarda; el servidor
 * recalcula todo igualmente y no se fía de lo que manda la pantalla.
 */
export function FormularioCompra({ modo, opciones, hoy, inicial, proveedorInicial, puedeOperar = true }: {
  modo: 'crear' | 'editar'
  opciones: OpcionesCompra
  /** Día del negocio (AAAA-MM-DD), para sugerir el vencimiento. */
  hoy: string
  inicial?: BorradorParaEditar
  proveedorInicial?: string
  /** La cuenta del negocio permite escribir (no está en solo lectura). */
  puedeOperar?: boolean
}) {
  const router = useRouter()
  const enLinea = useEnLinea()
  const [pendiente, startTransition] = useTransition()
  const [buscando, startBusqueda] = useTransition()
  const [error, setError] = useState<string | null>(null)
  // Una clave por formulario abierto: un reintento (red lenta, doble toque) devuelve el MISMO borrador en vez de crear otro.
  const [clave] = useState(() => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : '00000000-0000-4000-8000-000000000000'))

  const proveedorValido = (id: string | null | undefined) => (id && opciones.proveedores.some((p) => p.id === id) ? id : '')
  const [almacen, setAlmacen] = useState(inicial?.warehouseId ?? opciones.almacenes[0]?.id ?? '')
  const [proveedorId, setProveedorId] = useState(proveedorValido(inicial?.supplierId ?? proveedorInicial))
  const [condicion, setCondicion] = useState<CondicionCompra>(inicial?.paymentCondition ?? 'CONTADO')
  const [vence, setVence] = useState(inicial?.vence ?? '')
  const [venceTocado, setVenceTocado] = useState(!!inicial?.vence)
  const [documento, setDocumento] = useState(inicial?.invoiceRef ?? '')
  const [notas, setNotas] = useState(inicial?.notes ?? '')
  const [lineas, setLineas] = useState<LineaFormulario[]>(() => (inicial?.lineas ?? []).map((l) => ({
    key: nuevaClave(), producto: l.producto, presentationId: l.presentationId ?? '', cantidad: l.cantidad, costo: l.costo,
  })))
  const [texto, setTexto] = useState('')
  const [resultados, setResultados] = useState<ProductoParaCompra[]>([])
  const ultimaBusqueda = useRef('')

  const proveedor = opciones.proveedores.find((p) => p.id === proveedorId)
  // Al editar: si el proveedor del borrador se dio de baja, ya no está entre las opciones. Se avisa en vez de cambiarlo en silencio.
  const proveedorPerdido = modo === 'editar' && !!inicial?.supplierId && !proveedorValido(inicial.supplierId)
  // El vencimiento sugerido sigue al proveedor mientras la persona no lo cambie a mano.
  const venceMostrado = condicion === 'CREDITO' && !venceTocado ? venceSugerido(hoy, proveedor?.paymentTermDays ?? 0) : vence

  useEffect(() => {
    const t = texto.trim()
    if (t.length < 2) { setResultados([]); return }
    const id = setTimeout(() => {
      ultimaBusqueda.current = t
      startBusqueda(async () => {
        const r = await buscarProductosCompra({ texto: t })
        if (ultimaBusqueda.current !== t) return   // llegó tarde: ya se está buscando otra cosa
        if (r.ok) setResultados(r.data); else setError(r.message)
      })
    }, 250)
    return () => clearTimeout(id)
  }, [texto])

  const resumen = useMemo(() => resumenBorrador(lineas.map((l) => ({ cantidad: l.cantidad, costo: l.costo, tasa: l.producto.taxRate }))), [lineas])
  const motivo = motivoNoGuardable({ condicion, proveedorId, lineas: lineas.map((l) => ({ cantidad: l.cantidad, costo: l.costo, tasa: l.producto.taxRate })) })
  const sinAlmacen = opciones.almacenes.length === 0

  const agregar = (p: ProductoParaCompra) => {
    setLineas((ls) => [...ls, { key: nuevaClave(), producto: p, presentationId: '', cantidad: '', costo: '' }])
    setTexto(''); setResultados([])
  }
  const cambiarLinea = (key: string, cambio: Partial<LineaFormulario>) => setLineas((ls) => ls.map((l) => (l.key === key ? { ...l, ...cambio } : l)))
  const quitar = (key: string) => setLineas((ls) => ls.filter((l) => l.key !== key))

  const guardar = (e: { preventDefault(): void }) => {
    e.preventDefault()
    if (!enLinea) { setError(MENSAJE_SIN_RED); return }
    if (motivo) { setError(motivo); return }
    setError(null)
    startTransition(async () => {
      const cabecera = {
        warehouseId: almacen, supplierId: proveedorId || null, invoiceRef: documento, paymentCondition: condicion,
        vence: condicion === 'CREDITO' ? venceMostrado : undefined, notes: notas,
        items: lineas.map((l) => ({
          productId: l.producto.productId, presentationId: l.presentationId || null,
          enteredQuantity: l.cantidad.trim().replace(',', '.'), unitCost: Number(l.costo.trim().replace(',', '.')),
        })),
      }
      const r = modo === 'crear' ? await crearBorrador({ ...cabecera, idempotencyKey: clave }) : await editarBorrador({ ...cabecera, purchaseId: inicial!.id })
      if (!r.ok) { setError(r.message); return }
      router.push(`/compras/${r.data.id}`)
      router.refresh()
    })
  }

  return (
    <form onSubmit={guardar} data-form={`compra-${modo}`} className="flex flex-col gap-4">
      <section aria-label="Datos de la compra" className="flex flex-col gap-3 rounded-2xl border border-hairline bg-surface p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm font-semibold text-ink">Proveedor
            <select name="supplierId" value={proveedorId} onChange={(e) => setProveedorId(e.target.value)} className={campo}>
              <option value="">Sin proveedor (compra suelta)</option>
              {opciones.proveedores.map((p) => <option key={p.id} value={p.id}>{p.name}{p.taxId ? ` · ${p.taxId}` : ''}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm font-semibold text-ink">Llega al almacén
            <select name="warehouseId" value={almacen} onChange={(e) => setAlmacen(e.target.value)} disabled={sinAlmacen} className={campo}>
              {opciones.almacenes.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm font-semibold text-ink">N.º de factura, boleta o guía del proveedor
            <input name="invoiceRef" value={documento} onChange={(e) => setDocumento(e.target.value)} maxLength={40} placeholder="F001-000123" className={campo} />
          </label>
          <fieldset className="flex flex-col gap-1 text-sm font-semibold text-ink">
            <legend className="mb-1">Condición de pago</legend>
            <div className="flex gap-2">
              {(['CONTADO', 'CREDITO'] as const).map((c) => (
                <label key={c} className={`flex h-touch flex-1 items-center justify-center rounded-xl border px-3 ${condicion === c ? 'border-industrial-600 bg-industrial-600 text-white' : 'border-hairline text-ink'}`}>
                  <input type="radio" name="paymentCondition" value={c} checked={condicion === c} onChange={() => setCondicion(c)} className="sr-only" />
                  {ETIQUETA_CONDICION[c]}
                </label>
              ))}
            </div>
          </fieldset>
          {condicion === 'CREDITO' && (
            <label className="flex flex-col gap-1 text-sm font-semibold text-ink">Vence
              <input type="date" name="vence" value={venceMostrado} onChange={(e) => { setVence(e.target.value); setVenceTocado(true) }} className={campo} />
              <button type="button" data-boton="vence-hoy" onClick={() => { setVence(hoy); setVenceTocado(true) }} className="self-start text-xs font-semibold text-industrial-600 underline">Vence hoy (se paga al recibir)</button>
              <span className="text-xs font-normal text-ink-muted">{proveedor ? `Sugerido: hoy + ${proveedor.paymentTermDays} días de plazo del proveedor.` : 'Elige el proveedor: a crédito es obligatorio.'}</span>
            </label>
          )}
        </div>
        <label className="flex flex-col gap-1 text-sm font-semibold text-ink">Notas
          <textarea name="notes" value={notas} onChange={(e) => setNotas(e.target.value)} maxLength={500} rows={2} className={`${campo} h-auto py-2`} />
        </label>
        {proveedorPerdido && <p role="alert" data-aviso="proveedor-de-baja" className="text-sm font-semibold text-stock-low">El proveedor de este borrador ya no está activo: elige otro o reactívalo antes de guardar.</p>}
        {sinAlmacen && <p role="alert" data-aviso="sin-almacen" className="text-sm font-semibold text-stock-out">Tu sucursal no tiene almacenes activos: no se puede registrar la compra.</p>}
      </section>

      <section aria-label="Productos" className="flex flex-col gap-3 rounded-2xl border border-hairline bg-surface p-4">
        <h2 className="font-bold text-ink">Productos</h2>
        <label className="flex flex-col gap-1 text-sm font-semibold text-ink">Agregar producto
          <input type="search" value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="Nombre, SKU o código de barras" aria-label="Buscar producto para la compra" maxLength={80} className={campo} />
        </label>
        {buscando && <p className="text-xs text-ink-muted">Buscando…</p>}
        {resultados.length > 0 && (
          <ul data-lista="resultados" className="flex flex-col divide-y divide-hairline rounded-xl border border-hairline">
            {resultados.map((p) => (
              <li key={p.productId}>
                <button type="button" data-producto={p.productId} onClick={() => agregar(p)} className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-surface-sunken">
                  <span className="min-w-0"><span className="block truncate font-semibold text-ink">{p.name}</span><span className="text-xs text-ink-muted">{p.sku}</span></span>
                  <span className="shrink-0 text-xs text-ink-muted">{p.costPrice > 0 ? `costo ${money(p.costPrice)}` : 'sin costo'}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {texto.trim().length >= 2 && !buscando && resultados.length === 0 && <p data-lista="sin-resultados" className="text-sm text-ink-muted">Ningún producto con control de stock coincide.</p>}

        {lineas.length === 0 ? (
          <p data-lista="sin-lineas" className="text-sm text-ink-muted">Todavía no hay productos en la compra.</p>
        ) : (
          <ul className="flex flex-col gap-3" aria-label="Líneas de la compra">
            {lineas.map((l, i) => {
              const total = resumen.totales[i] ?? null
              return (
                <li key={l.key} data-linea={l.producto.productId} className="flex flex-col gap-2 rounded-xl border border-hairline p-3">
                  <div className="flex items-start justify-between gap-2">
                    <p className="min-w-0 font-semibold text-ink">{l.producto.name}<span className="block text-xs font-normal text-ink-muted">{l.producto.sku}{l.producto.costPrice > 0 ? ` · costo actual ${money(l.producto.costPrice)} por ${l.producto.unitType.toLowerCase()}` : ''}{l.producto.taxRate === 0 ? ' · sin IGV' : ''}</span></p>
                    <button type="button" data-boton="quitar" onClick={() => quitar(l.key)} aria-label={`Quitar ${l.producto.name}`} className="h-touch shrink-0 rounded-xl border border-hairline px-3 text-sm font-semibold text-ink">Quitar</button>
                  </div>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {l.producto.presentaciones.length > 0 && (
                      <label className="col-span-2 flex flex-col gap-1 text-xs font-semibold text-ink">Se compra por
                        <select value={l.presentationId} onChange={(e) => cambiarLinea(l.key, { presentationId: e.target.value })} className={campo}>
                          <option value="">{l.producto.unitType.toLowerCase()} (unidad base)</option>
                          {l.producto.presentaciones.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.factor})</option>)}
                        </select>
                      </label>
                    )}
                    <label className="flex flex-col gap-1 text-xs font-semibold text-ink">Cantidad
                      <input value={l.cantidad} onChange={(e) => cambiarLinea(l.key, { cantidad: e.target.value })} inputMode="decimal" maxLength={14} aria-label={`Cantidad de ${l.producto.name}`} className={campo} />
                    </label>
                    <label className="flex flex-col gap-1 text-xs font-semibold text-ink">Costo sin IGV
                      <input value={l.costo} onChange={(e) => cambiarLinea(l.key, { costo: e.target.value })} inputMode="decimal" maxLength={14} aria-label={`Costo de ${l.producto.name}`} className={campo} />
                    </label>
                  </div>
                  <p className="text-right text-sm text-ink">
                    <span className="text-xs text-ink-muted">por {unidadDeLinea(l)} · </span>
                    <b data-total-linea className="tabular-nums">{total === null ? '—' : money(total)}</b>
                  </p>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section aria-label="Totales" className="flex flex-col gap-1 rounded-2xl border border-hairline bg-surface p-4 text-sm">
        <p className="flex justify-between text-ink"><span>Valor de compra (sin IGV)</span><b data-total="subtotal" className="tabular-nums">{money(resumen.subtotal)}</b></p>
        <p className="flex justify-between text-ink"><span>IGV</span><b data-total="igv" className="tabular-nums">{money(resumen.igv)}</b></p>
        <p className="flex justify-between text-lg text-ink"><span className="font-bold">Total</span><b data-total="total" className="tabular-nums">{money(resumen.total)}</b></p>
        <p className="text-xs text-ink-muted">El costo de cada producto se guarda SIN IGV. Guardar no mueve el stock: eso pasa al recibir la mercadería.</p>
      </section>

      {error && <p role="alert" data-form="error" className="rounded-xl bg-stock-out-soft px-3 py-2 text-sm font-semibold text-stock-out">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" data-boton="guardar-compra" disabled={pendiente || !enLinea || !!motivo || sinAlmacen || !puedeOperar} className="h-touch flex-1 rounded-xl bg-industrial-600 font-bold text-white disabled:opacity-40">
          {pendiente ? 'Guardando…' : modo === 'crear' ? 'Guardar borrador' : 'Guardar cambios'}
        </button>
        <button type="button" onClick={() => router.back()} className="h-touch rounded-xl border border-hairline px-4 font-semibold text-ink">Cancelar</button>
      </div>
      {motivo && lineas.length > 0 && <p data-aviso="no-guardable" className="text-sm text-ink-muted">{motivo}</p>}
    </form>
  )
}
