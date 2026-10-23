import Link from 'next/link'
import { describirAntiguedad, type EstadoEnvioFiscal } from '../alarma-envio'

const TONOS = {
  aviso: 'border-stock-low/40 bg-stock-low-soft text-stock-low',
  critico: 'border-stock-out/40 bg-stock-out-soft text-stock-out',
} as const

/**
 * Barra de alarma de comprobantes sin enviar. Se ve cuando el envío está en pausa o cuando lo
 * pendiente pasa de los umbrales. Componente de servidor: no consulta nada, recibe el estado.
 */
export function FiscalAlertBar({ estado }: { estado: EstadoEnvioFiscal }) {
  if (!estado.mostrar || estado.nivel === 'ok') return null
  const titulo = estado.agotados > 0
    ? 'Hay comprobantes que no se pudieron enviar a SUNAT'
    : estado.pausado
    ? 'El envío de comprobantes a SUNAT está en pausa'
    : estado.nivel === 'critico'
      ? 'Comprobantes sin enviar a SUNAT: atención urgente'
      : 'Hay comprobantes sin enviar a SUNAT'
  return (
    <div role="alert" className={`flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 ${TONOS[estado.nivel]}`}>
      <div className="min-w-0">
        <p className="text-sm font-bold">{titulo}</p>
        <p className="text-sm">
          {estado.agotados > 0 && (
            <><b>{estado.agotados}</b> {estado.agotados === 1 ? 'comprobante agotó' : 'comprobantes agotaron'} sus reintentos SIN respuesta del proveedor y ya no se reintentan solos: hay que revisarlos y reintentar a mano. </>
          )}
          {estado.sinEnviar === 0
            ? (estado.agotados > 0 ? '' : 'No hay comprobantes pendientes ahora.')
            : <>
                <b>{estado.sinEnviar}</b> {estado.sinEnviar === 1 ? 'comprobante sin enviar' : 'comprobantes sin enviar'}
                {estado.masAntiguoHoras !== null && <>; el más antiguo lleva <b>{describirAntiguedad(estado.masAntiguoHoras)}</b></>}
                {' '}(aviso a las {estado.umbrales.avisoHoras} h, crítico a las {estado.umbrales.criticoHoras} h).
              </>}
        </p>
      </div>
      <Link href="/comprobantes" className="shrink-0 rounded-xl border border-current px-3 py-2 text-sm font-bold">
        Ver comprobantes
      </Link>
    </div>
  )
}
