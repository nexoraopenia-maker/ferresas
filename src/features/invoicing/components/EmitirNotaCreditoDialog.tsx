'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { emitirNotaCreditoAction } from '../actions'
import type { CodigoMotivoNota } from '../motivos-nota'
import { FormularioNotaCredito, type DocParaFormulario, type EstadoFormulario } from './FormularioNotaCredito'

/**
 * Botón + diálogo para emitir la nota de crédito TOTAL de un comprobante.
 *
 * Si `razonBloqueo` viene informada, el botón sale desactivado y la dice: es solo la cara visible, el servicio
 * vuelve a comprobar todo. Cerrar el diálogo a mitad de una emisión no la cancela (el servidor ya está en ello):
 * mientras se emite no se puede cerrar.
 */
export function EmitirNotaCreditoDialog({
  saleId, doc, razonBloqueo,
}: {
  saleId: string
  doc: DocParaFormulario
  razonBloqueo: string | null
}) {
  const router = useRouter()
  const [abierto, setAbierto] = useState(false)
  const [motivo, setMotivo] = useState<CodigoMotivoNota | ''>('')
  const [sustento, setSustento] = useState('')
  const [confirmado, setConfirmado] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [emitida, setEmitida] = useState<{ fullNumber: string } | null>(null)
  const [pendiente, startTransition] = useTransition()

  const estado: EstadoFormulario = emitida ? 'emitida' : pendiente ? 'enviando' : 'editando'

  const reiniciar = () => { setMotivo(''); setSustento(''); setConfirmado(false); setError(null); setEmitida(null) }
  const cambiar = (v: boolean) => {
    if (!v && pendiente) return
    if (!v) { if (emitida) router.refresh(); reiniciar() }
    setAbierto(v)
  }

  const emitir = () => {
    if (motivo === '') return
    setError(null)
    startTransition(async () => {
      const r = await emitirNotaCreditoAction({ saleId, reasonCode: motivo, reasonDescription: sustento })
      if (!r.ok) { setError(r.message); return }
      setEmitida({ fullNumber: r.data.fullNumber })
      router.refresh()
    })
  }

  if (razonBloqueo) {
    return (
      <div className="max-w-[12rem]">
        <button type="button" disabled className="h-touch rounded-lg border border-hairline px-3 text-sm font-semibold text-ink opacity-50">
          Nota de crédito
        </button>
        <p className="mt-1 text-xs text-ink-muted">{razonBloqueo}</p>
      </div>
    )
  }

  return (
    <Dialog open={abierto} onOpenChange={cambiar}>
      <button
        type="button" onClick={() => cambiar(true)}
        className="h-touch rounded-lg border border-hairline px-3 text-sm font-semibold text-ink"
      >
        Nota de crédito
      </button>
      {abierto && (
        <DialogContent title="Emitir nota de crédito" description="Anula el comprobante completo.">
          <FormularioNotaCredito
            doc={doc} motivo={motivo} sustento={sustento} confirmado={confirmado}
            estado={estado} error={error} emitida={emitida}
            onMotivo={setMotivo} onSustento={setSustento} onConfirmado={setConfirmado}
            onEmitir={emitir} onCerrar={() => cambiar(false)}
          />
        </DialogContent>
      )}
    </Dialog>
  )
}
