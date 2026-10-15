'use client'

import { useState, useTransition } from 'react'
import { findOrCreateCustomerByDoc, type PosCustomer } from '../actions'

/**
 * Asignación rápida de cliente por DNI/RUC, encima del carrito.
 *
 * El tipo de documento se DEDUCE del largo —8 dígitos DNI, 11 RUC— en lugar
 * de preguntarlo. El número ya lo dice, y un desplegable más mientras el
 * cliente espera en el mostrador es fricción sin contrapartida.
 *
 * Si el documento no está en el padrón, NO se crea un cliente a ciegas: se
 * pide el nombre. Un registro llamado "20512345678" ensucia la base para
 * siempre y reaparece en cada búsqueda futura.
 */
export function CustomerPicker({
  cliente,
  onChange,
}: {
  cliente: PosCustomer | null
  onChange: (c: PosCustomer | null) => void
}) {
  const [doc, setDoc] = useState('')
  const [nombre, setNombre] = useState('')
  const [pidiendoNombre, setPidiendoNombre] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const buscar = (conNombre: boolean) => {
    setError(null)
    startTransition(async () => {
      const res = await findOrCreateCustomerByDoc({
        docNumber: doc,
        name: conNombre ? nombre : undefined,
      })

      if (!res.ok) {
        setError(res.message)
        return
      }

      if (!res.data) {
        // No existe: se pide el nombre en lugar de inventarlo.
        setPidiendoNombre(true)
        return
      }

      onChange(res.data)
      setDoc('')
      setNombre('')
      setPidiendoNombre(false)
    })
  }

  if (cliente) {
    const esRuc = cliente.docType === 'RUC'
    return (
      <div className="flex items-center gap-3 rounded-xl border border-industrial-600/40 bg-industrial-50 px-3 py-2 dark:bg-industrial-950">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold text-ink">{cliente.name}</p>
          <p className="font-mono text-xs text-ink-muted">
            {cliente.docType} {cliente.docNumber}
            {cliente.creado && ' · nuevo'}
          </p>
        </div>
        {/* Que se vea qué comprobante permite este documento evita el error
            de intentar una factura con DNI y descubrirlo al emitir. */}
        <span className={`shrink-0 rounded-full px-2 py-1 text-xs font-bold ${
          esRuc ? 'bg-stock-ok-soft text-stock-ok' : 'bg-surface-sunken text-ink-muted'
        }`}>
          {esRuc ? 'Factura o boleta' : 'Solo boleta'}
        </span>
        <button
          type="button"
          onClick={() => { onChange(null); setPidiendoNombre(false) }}
          aria-label="Quitar cliente"
          className="h-touch shrink-0 rounded-lg px-2 text-sm font-semibold text-ink-muted"
        >
          Quitar
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-hairline bg-surface p-3">
      <div className="flex gap-2">
        <input
          value={doc}
          onChange={(e) => {
            setDoc(e.target.value.replace(/\D/g, '').slice(0, 11))
            setPidiendoNombre(false)
            setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !pidiendoNombre) { e.preventDefault(); buscar(false) }
          }}
          inputMode="numeric"
          placeholder="DNI o RUC del cliente"
          aria-label="DNI o RUC del cliente"
          className="h-touch-lg min-w-0 flex-1 rounded-xl border border-hairline bg-surface px-3 font-mono text-base text-ink placeholder:font-sans placeholder:text-ink-muted focus:border-industrial-600 focus:outline-none focus:ring-2 focus:ring-industrial-600/40"
        />
        <button
          type="button"
          onClick={() => buscar(false)}
          disabled={pending || !(doc.length === 8 || doc.length === 11)}
          className="h-touch-lg shrink-0 rounded-xl bg-graphite-900 px-4 text-sm font-bold text-white disabled:opacity-40 dark:bg-graphite-50 dark:text-graphite-900"
        >
          {pending ? '…' : 'Buscar'}
        </button>
      </div>

      {doc.length > 0 && doc.length !== 8 && doc.length !== 11 && (
        <p className="text-xs text-ink-muted">
          {doc.length} dígitos · DNI son 8, RUC son 11
        </p>
      )}

      {pidiendoNombre && (
        <div className="flex flex-col gap-2 border-t border-hairline pt-2">
          <p className="text-xs font-semibold text-ink">
            No está registrado. ¿Cómo se llama?
          </p>
          <div className="flex gap-2">
            <input
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); buscar(true) }
              }}
              autoFocus
              placeholder={doc.length === 11 ? 'Razón social' : 'Nombre y apellidos'}
              className="h-touch-lg min-w-0 flex-1 rounded-xl border border-hairline bg-surface px-3 text-base text-ink focus:border-industrial-600 focus:outline-none focus:ring-2 focus:ring-industrial-600/40"
            />
            <button
              type="button"
              onClick={() => buscar(true)}
              disabled={pending || nombre.trim().length < 2}
              className="h-touch-lg shrink-0 rounded-xl bg-industrial-600 px-4 text-sm font-bold text-white disabled:opacity-40"
            >
              Crear
            </button>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="text-xs font-semibold text-stock-out">{error}</p>
      )}
    </div>
  )
}
