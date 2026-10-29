import Link from 'next/link'
import type { EstadoCertificado } from '@/features/sunat/certificado'

/**
 * Aviso de vencimiento del certificado digital: un certificado caducado detiene la emisión, y se quiere saber con semanas de antelación, no el día
 * que falla una venta. Componente de servidor: recibe el estado, no consulta nada. Solo una barra dentro del panel (sin correos).
 */
export function CertificadoAlertBar({ estado, diasRestantes }: { estado: EstadoCertificado; diasRestantes: number }) {
  if (estado === 'vigente') return null
  const vencido = estado === 'vencido'
  const texto = vencido ? 'El certificado digital de SUNAT está vencido: no se pueden emitir comprobantes.'
    : estado === 'aun_no_vigente' ? 'El certificado digital de SUNAT todavía no está vigente.'
    : `El certificado digital de SUNAT vence en ${diasRestantes} día${diasRestantes === 1 ? '' : 's'}. Renuévalo a tiempo.`
  return (
    <div role="alert" data-alerta="certificado" className={`flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 ${vencido ? 'border-stock-out/40 bg-stock-out-soft text-stock-out' : 'border-stock-low/40 bg-stock-low-soft text-stock-low'}`}>
      <p className="text-sm font-bold">{texto}</p>
      <Link href="/comprobantes" className="shrink-0 rounded-xl border border-current px-3 py-2 text-sm font-bold">Ir a Comprobantes</Link>
    </div>
  )
}
