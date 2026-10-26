import './a4.css'

/**
 * Contenedor de los informes impresos en A4. FUERA del grupo (dashboard), como (print): un informe con el menú del panel alrededor
 * saldría impreso con el menú encima. Su `@page` (A4) solo afecta a estas rutas.
 */
export default function ImpresionA4Layout({ children }: { children: React.ReactNode }) {
  return <div className="a4-pantalla">{children}</div>
}
