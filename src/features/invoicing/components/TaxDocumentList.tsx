'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { formatearFechaLocal } from '@/lib/fecha-local'
import { EmitirNotaCreditoDialog } from './EmitirNotaCreditoDialog'
import { nombreMotivo, razonSinNota } from '../motivos-nota'

export interface TaxDocRow {
  id: string
  fullNumber: string
  documentType: string
  status: string
  statusMessage: string | null
  receiverDocNumber: string | null
  receiverName: string | null
  currency: string
  subtotal: string
  taxTotal: string
  total: string
  issuedAt: string
  saleNumber: string
  /** Venta del comprobante: de ahí se vincula la guía de remisión. */
  saleId: string
  /** Documento de PRUEBA: serie PB001/PF001, sin valor tributario; no se envía ni cambia de estado. */
  isTrial: boolean
  series: string
  /** Archivos fiscales guardados (S3): el XML firmado y el CDR de SUNAT, para descargarlos. */
  archivos: ('XML_FIRMADO' | 'CDR')[]
  /** Notas: número del comprobante que modifican, y el código de su motivo. */
  documentoRelacionado: string | null
  motivo: string | null
  /** Boleta/factura: número de su nota de crédito total viva, si ya la tiene. */
  notaTotal: string | null
  /** El proveedor le dio un identificador (prueba de que lo conoce). */
  tieneIdProveedor: boolean
  /** Estado de su fila en la cola de envío (null si no está en cola). */
  cola: { estado: string; intentos: number; proximo: string; error: string | null } | null
}

const ESTADO: Record<string, { texto: string; cls: string }> = {
  PENDIENTE: { texto: 'Pendiente', cls: 'bg-stock-low-soft text-stock-low' },
  ENVIADO: { texto: 'Enviado', cls: 'bg-industrial-100 text-industrial-800 dark:bg-industrial-950 dark:text-industrial-300' },
  ACEPTADO: { texto: 'Aceptado', cls: 'bg-stock-ok-soft text-stock-ok' },
  OBSERVADO: { texto: 'Aceptado con observaciones', cls: 'bg-stock-low-soft text-stock-low' },
  RECHAZADO: { texto: 'Rechazado', cls: 'bg-stock-out-soft text-stock-out' },
  ANULADO: { texto: 'Anulado', cls: 'bg-surface-sunken text-ink-muted' },
}

const TIPO: Record<string, string> = { FACTURA: 'Factura', BOLETA: 'Boleta', NOTA_CREDITO: 'Nota de crédito', NOTA_DEBITO: 'Nota de débito' }
const esNota = (d: { documentType: string }) => d.documentType === 'NOTA_CREDITO' || d.documentType === 'NOTA_DEBITO'

/** Transiciones permitidas; deben coincidir con las del servicio. */
const SIGUIENTES: Record<string, string[]> = {
  PENDIENTE: ['ENVIADO', 'ACEPTADO', 'RECHAZADO'],
  ENVIADO: ['ACEPTADO', 'RECHAZADO'],
  RECHAZADO: ['ENVIADO', 'ACEPTADO'],
  ACEPTADO: [],
  OBSERVADO: [],
  ANULADO: [],
}

export function TaxDocumentList({
  docs,
  canManage,
  puedeEnviar = false,
  puedeEmitirGuia = false,
  puedeEmitirNota = false,
  facturacionActiva = false,
  zonaHoraria,
}: {
  docs: TaxDocRow[]
  canManage: boolean
  /** Puede mandar comprobantes al proveedor de facturación. */
  puedeEnviar?: boolean
  /** Puede emitir guías de remisión: muestra el enlace en cada comprobante. */
  puedeEmitirGuia?: boolean
  /** Puede emitir notas de crédito (comprobantes.anular). */
  puedeEmitirNota?: boolean
  /**
   * Facturación electrónica REAL o en pausa: el estado lo fija solo la respuesta del proveedor (cola o «Consultar»),
   * así que no se ofrece cambiarlo a mano (el servicio también lo rechaza).
   */
  facturacionActiva?: boolean
  /** Zona del negocio: ver la nota en CashPanel. */
  zonaHoraria: string
}) {
  const router = useRouter()
  const [editando, setEditando] = useState<TaxDocRow | null>(null)
  const [nuevoEstado, setNuevoEstado] = useState('')
  const [mensaje, setMensaje] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pendiente, startTransition] = useTransition()

  const [aviso, setAviso] = useState<string | null>(null)
  // Facturación activa: ningún estado se declara a mano; lo fija la cola o «Consultar».
  const siguientes = (estado: string) => (facturacionActiva ? [] : SIGUIENTES[estado] ?? [])
  const enviar = (id: string) => {
    setAviso(null)
    startTransition(async () => {
      const res = await fetch('/api/invoices/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ taxDocumentId: id }),
      })
      const d = await res.json().catch(() => null)
      if (!res.ok) { setAviso(d?.message ?? 'No se pudo enviar el comprobante.'); return }
      if (d?.reintentable) setAviso(d.mensaje ?? 'El proveedor no respondió; se puede reintentar.')
      router.refresh()
    })
  }

  const guardar = () => {
    if (!editando) return
    setError(null)
    if (mensaje.trim().length < 10) {
      setError('Explica por qué cambias el estado a mano: al menos 10 caracteres.')
      return
    }
    startTransition(async () => {
      const res = await fetch('/api/invoices/status', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          taxDocumentId: editando.id,
          status: nuevoEstado,
          motivo: mensaje.trim(),
        }),
      })
      const d = await res.json().catch(() => null)
      if (!res.ok) {
        setError(d?.message ?? 'No se pudo actualizar el estado.')
        return
      }
      setEditando(null)
      setMensaje('')
      router.refresh()
    })
  }

  if (docs.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-hairline px-4 py-10 text-center text-sm text-ink-muted">
        Todavía no has emitido comprobantes. Se emiten desde el punto de venta,
        al terminar una venta.
      </p>
    )
  }

  return (
    <>
      {aviso && (
        <p role="alert" className="mb-3 rounded-xl bg-stock-low-soft px-3 py-2 text-sm font-semibold text-stock-low">
          {aviso}
        </p>
      )}
      <div className="overflow-hidden rounded-2xl border border-hairline bg-surface">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[44rem] text-sm">
            <thead className="bg-surface-sunken text-left text-ink-muted">
              <tr>
                <th className="px-3 py-2 font-semibold">Comprobante</th>
                <th className="px-3 py-2 font-semibold">Cliente</th>
                <th className="px-3 py-2 font-semibold">Importes</th>
                <th className="px-3 py-2 font-semibold">Estado</th>
                <th className="px-3 py-2 font-semibold">Imprimir</th>
                {canManage && <th className="px-3 py-2 font-semibold">Acción</th>}
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => {
                const e = d.isTrial
                  ? { texto: 'Prueba, sin valor tributario', cls: 'bg-surface-sunken text-ink-muted' }
                  : ESTADO[d.status] ?? { texto: d.status, cls: '' }
                return (
                  <tr key={d.id} className="border-t border-hairline align-top">
                    <td className="px-3 py-3">
                      <p className="font-mono font-bold text-ink">{d.fullNumber}</p>
                      <p className="text-xs text-ink-muted">
                        {TIPO[d.documentType] ?? d.documentType} · venta {d.saleNumber}
                      </p>
                      {esNota(d) && (
                        <p className="text-xs font-semibold text-ink">
                          Modifica a <span className="font-mono">{d.documentoRelacionado ?? '—'}</span>
                          {d.motivo && <> · motivo {d.motivo}{nombreMotivo(d.motivo) ? ` (${nombreMotivo(d.motivo)})` : ''}</>}
                        </p>
                      )}
                      <p className="text-xs text-ink-muted">
                        {formatearFechaLocal(d.issuedAt, zonaHoraria)}
                      </p>
                      {puedeEmitirGuia && !esNota(d) && (
                        <Link href={`/guias/nueva?venta=${d.saleId}`} className="mt-1 inline-block text-xs font-semibold text-industrial-700 underline dark:text-industrial-300">
                          Emitir guía de remisión
                        </Link>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      <p className="text-ink">{d.receiverName ?? 'Sin cliente'}</p>
                      {d.receiverDocNumber && (
                        <p className="font-mono text-xs text-ink-muted">{d.receiverDocNumber}</p>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      <p className="font-bold text-ink">{d.currency} {d.total}</p>
                      <p className="text-xs text-ink-muted">
                        base {d.subtotal} · IGV {d.taxTotal}
                      </p>
                    </td>
                    <td className="px-3 py-3">
                      <span className={`rounded-full px-2 py-1 text-xs font-bold ${e.cls}`}>
                        {e.texto}
                      </span>
                      {!d.isTrial && d.cola && d.cola.estado !== 'COMPLETADO' && (
                        <p className={`mt-1 max-w-[16rem] text-xs font-semibold ${d.cola.estado === 'AGOTADO' ? 'text-stock-out' : 'text-ink-muted'}`}>
                          {d.cola.estado === 'AGOTADO'
                            ? 'Se agotaron los reintentos: el proveedor no respondió. Reintenta a mano.'
                            : d.cola.estado === 'EN_CURSO'
                              ? 'Enviándose…'
                              : d.cola.intentos > 0
                                ? `En cola · ${d.cola.intentos} intento(s) fallido(s) · reintenta ${formatearFechaLocal(d.cola.proximo, zonaHoraria)}`
                                : 'En cola de envío'}
                        </p>
                      )}
                      {d.statusMessage && (
                        <p className="mt-1 max-w-[16rem] text-xs text-ink-muted">{d.statusMessage}</p>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      {/*
                        * Reimprimir no es una escritura, así que está abierto
                        * a cualquier rol: el cliente que vuelve con el ticket
                        * perdido lo atiende quien esté en el mostrador.
                        */}
                      {esNota(d) ? (
                        <span className="text-xs text-ink-muted">Impresión próximamente</span>
                      ) : (
                        <a
                          href={`/imprimir/comprobante/${d.id}?auto=1`}
                          target="_blank"
                          rel="noopener"
                          className="h-touch inline-flex items-center rounded-lg border border-hairline px-3 text-sm font-semibold text-ink"
                        >
                          80 mm
                        </a>
                      )}
                      {d.archivos.length > 0 && (
                        <span data-comprobante="archivos" className="ml-2 inline-flex gap-2 align-middle text-xs font-semibold">
                          {d.archivos.includes('XML_FIRMADO') && <a href={`/api/comprobantes/${d.id}/archivo?tipo=xml`} className="underline">XML</a>}
                          {d.archivos.includes('CDR') && <a href={`/api/comprobantes/${d.id}/archivo?tipo=cdr`} className="underline">CDR</a>}
                        </span>
                      )}
                      {puedeEnviar && !d.isTrial && (d.status === 'PENDIENTE' || d.status === 'ENVIADO') && (
                        <button
                          type="button" disabled={pendiente} onClick={() => enviar(d.id)}
                          className="ml-2 h-touch rounded-lg bg-industrial-600 px-3 text-sm font-bold text-white disabled:opacity-50"
                        >
                          {d.status === 'ENVIADO' ? 'Consultar' : d.cola?.estado === 'AGOTADO' ? 'Reintentar' : 'Enviar'}
                        </button>
                      )}
                    </td>
                    {canManage && (
                      <td className="px-3 py-3">
                        <div className="flex flex-col items-start gap-2">
                          {d.isTrial ? (
                            <span className="text-xs text-ink-muted">—</span>
                          ) : siguientes(d.status).length ? (
                            <button
                              type="button"
                              onClick={() => {
                                setEditando(d)
                                setNuevoEstado(siguientes(d.status)[0]!)
                                setError(null)
                              }}
                              className="h-touch rounded-lg border border-hairline px-3 text-sm font-semibold text-ink"
                            >
                              Cambiar
                            </button>
                          ) : (
                            <span className="text-xs text-ink-muted">
                              {facturacionActiva && !['ACEPTADO', 'OBSERVADO', 'ANULADO'].includes(d.status) ? 'Lo fija el proveedor' : 'Final'}
                            </span>
                          )}
                          {puedeEmitirNota && !esNota(d) && (
                            <EmitirNotaCreditoDialog
                              saleId={d.saleId}
                              razonBloqueo={razonSinNota(d, facturacionActiva)}
                              doc={{
                                fullNumber: d.fullNumber, receiverName: d.receiverName, receiverDocNumber: d.receiverDocNumber,
                                currency: d.currency, total: d.total, fecha: formatearFechaLocal(d.issuedAt, zonaHoraria),
                              }}
                            />
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {editando && (
        <div className="fixed inset-0 z-50 grid place-items-center p-4">
          <div className="absolute inset-0 bg-graphite-950/70" onClick={() => setEditando(null)} aria-hidden />
          <div role="dialog" aria-modal="true" className="relative w-full max-w-sm rounded-2xl bg-surface p-5 shadow-2xl">
            <h2 className="text-lg font-bold text-ink">Estado tributario</h2>
            <p className="mt-1 font-mono text-sm text-ink-muted">{editando.fullNumber}</p>

            <label className="mt-4 flex flex-col gap-1">
              <span className="text-sm font-medium text-ink-muted">Nuevo estado</span>
              <select value={nuevoEstado} onChange={(e) => setNuevoEstado(e.target.value)}
                className="h-touch-lg rounded-xl border border-hairline bg-surface px-4 text-base text-ink">
                {siguientes(editando.status).map((s) => (
                  <option key={s} value={s}>{ESTADO[s]?.texto ?? s}</option>
                ))}
              </select>
            </label>

            <label className="mt-3 flex flex-col gap-1">
              <span className="text-sm font-medium text-ink-muted">
                Motivo del cambio <span className="font-bold text-stock-out">(obligatorio)</span>
              </span>
              <textarea value={mensaje} onChange={(e) => setMensaje(e.target.value)} rows={3}
                placeholder="Ej.: SUNAT respondió aceptado por el portal; CDR guardado fuera del sistema"
                className="rounded-xl border border-hairline bg-surface px-3 py-2 text-base text-ink" />
              <span className="text-xs text-ink-muted">
                Estás declarando a mano lo que respondió la administración
                tributaria. Queda registrado quién, cuándo, el estado anterior y
                este motivo.
              </span>
            </label>

            {error && (
              <p role="alert" className="mt-2 rounded-xl bg-stock-out-soft px-3 py-2 text-sm font-semibold text-stock-out">
                {error}
              </p>
            )}

            <div className="mt-4 flex gap-2">
              <button type="button" onClick={() => setEditando(null)}
                className="h-touch-lg flex-1 rounded-xl border border-hairline font-semibold text-ink">
                Cancelar
              </button>
              <button type="button" onClick={guardar} disabled={pendiente || mensaje.trim().length < 10}
                className="h-touch-lg flex-1 rounded-xl bg-industrial-600 font-bold text-white disabled:opacity-40">
                {pendiente ? 'Guardando…' : 'Guardar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
