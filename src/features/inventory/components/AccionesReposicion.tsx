'use client'

import { useRef, useState, useTransition } from 'react'
import Link from 'next/link'
import { MENSAJE_SIN_RED, useEnLinea } from '@/lib/en-linea'
import { crearBorradorDeCompraAccion, solicitarTransferenciaDesdeReposicionAccion } from '../reposicion-actions'

const BOTON = 'h-touch rounded-xl px-3 text-sm font-bold disabled:opacity-50'

/** «Crear borrador de compra» para un proveedor y un almacén: el servidor arma las líneas; aquí solo se dispara y se enseña a dónde ir a revisarlo. */
export function BotonBorradorCompra({ supplierId, warehouseId, etiqueta }: { supplierId: string | null; warehouseId: string; etiqueta: string }) {
  const enLinea = useEnLinea()
  const [pendiente, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [hecho, setHecho] = useState<{ id: string; number: string; lineas: number; variantesOmitidas: number; sinCosto: number } | null>(null)
  // Una clave por intento: si la red falla y se reintenta, o se hace doble clic, no se crean dos borradores.
  const clave = useRef(crypto.randomUUID())

  const crear = () => {
    setError(null)
    if (!enLinea) { setError(MENSAJE_SIN_RED); return }
    startTransition(async () => {
      const r = await crearBorradorDeCompraAccion({ supplierId, warehouseId, idempotencyKey: clave.current })
      if (!r.ok) { setError(r.message); return }
      setHecho(r.data)
    })
  }

  if (hecho) {
    return (
      <p data-reposicion="borrador-listo" role="status" className="text-sm font-semibold text-stock-ok">
        Borrador {hecho.number} creado con {hecho.lineas} {hecho.lineas === 1 ? 'producto' : 'productos'}.{' '}
        <Link href={`/compras/${hecho.id}`} className="underline">Revisarlo y editarlo</Link>
        {hecho.sinCosto > 0 && <span className="font-normal text-ink-muted"> · {hecho.sinCosto} sin costo conocido (van en 0)</span>}
        {hecho.variantesOmitidas > 0 && <span className="font-normal text-ink-muted"> · {hecho.variantesOmitidas} de variantes no entraron</span>}
      </p>
    )
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <button type="button" data-reposicion="crear-borrador" disabled={pendiente} onClick={crear} className={`${BOTON} bg-industrial-600 text-white`}>{pendiente ? 'Creando…' : etiqueta}</button>
      {error && <p role="alert" className="text-xs font-semibold text-stock-out">{error}</p>}
    </div>
  )
}

/** «Sugerir transferencia desde [Sucursal]»: pide a la sucursal con excedente lo que falta (la cantidad la calcula el servidor). */
export function BotonTransferencia({ fromWarehouseId, toWarehouseId, productId, variantId, texto }: { fromWarehouseId: string; toWarehouseId: string; productId: string; variantId: string | null; texto: string }) {
  const enLinea = useEnLinea()
  const [pendiente, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [hecho, setHecho] = useState<{ number: string; desde: string } | null>(null)

  const pedir = () => {
    setError(null)
    if (!enLinea) { setError(MENSAJE_SIN_RED); return }
    startTransition(async () => {
      const r = await solicitarTransferenciaDesdeReposicionAccion({ fromWarehouseId, toWarehouseId, items: [{ productId, variantId }] })
      if (!r.ok) { setError(r.message); return }
      setHecho({ number: r.data.number, desde: r.data.desde })
    })
  }

  if (hecho) {
    return (
      <p data-reposicion="transferencia-lista" role="status" className="text-sm font-semibold text-stock-ok">
        Pedido {hecho.number} enviado a {hecho.desde}. <Link href="/transferencias" className="underline">Ver transferencias</Link>
      </p>
    )
  }
  return (
    <div className="flex flex-col items-start gap-1">
      <button type="button" data-reposicion="pedir-transferencia" disabled={pendiente} onClick={pedir} className={`${BOTON} border border-hairline bg-surface text-ink`}>{pendiente ? 'Pidiendo…' : texto}</button>
      {error && <p role="alert" className="text-xs font-semibold text-stock-out">{error}</p>}
    </div>
  )
}
