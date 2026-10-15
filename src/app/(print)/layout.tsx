import './ticket.css'

/**
 * Contenedor de las vistas de impresión.
 *
 * Deliberadamente FUERA del grupo (dashboard): hereda el `<html>`/`<body>`
 * de la raíz pero ninguna de las barras de navegación. Un ticket con el
 * sidebar alrededor saldría impreso con el menú encima.
 *
 * `ticket.css` se importa solo aquí, así que la regla `@page { size: 80mm }`
 * no afecta a la impresión del resto del panel.
 */
export default function ImpresionLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <div className="ticket-pantalla">{children}</div>
}
