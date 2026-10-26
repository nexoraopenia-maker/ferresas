'use client'

/** Abre el diálogo de impresión (o «Guardar como PDF»). Solo existe en pantalla: la clase `no-imprimir` lo oculta en el papel. */
export function BotonImprimir() {
  return <button type="button" className="primario" onClick={() => window.print()}>Imprimir / guardar PDF</button>
}
