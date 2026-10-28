/**
 * Ayuda cuando una devolución se bloquea por `CREDIT_HAS_PAYMENTS` (la venta fiada ya tiene abonos cobrados): dice cómo destrabarla. Anular un
 * abono (incluso de un turno ya cerrado) es de quien tiene `credito.castigar`, desde la ficha del cliente; si el abono era en efectivo de un turno
 * cerrado, el sistema registra solo la compensación en la caja abierta. Sin ese permiso, se pide a un administrador. Sin cliente no hay abonos que anular.
 */
export function AyudaAbonos({ clienteId, puedeAnularAbonos }: { clienteId: string | null; puedeAnularAbonos: boolean }) {
  return (
    <p data-devolucion="ayuda-abonos" className="mt-1 text-sm font-normal text-ink">
      Para devolver más, primero hay que anular el abono cobrado: se anula desde la ficha del cliente y, si era en efectivo de un turno ya cerrado, el sistema
      registra solo la compensación en la caja abierta. {' '}
      {clienteId && puedeAnularAbonos
        ? <a data-devolucion="enlace-abonos" href={`/clientes/${clienteId}`} className="font-semibold underline">Ir a la ficha del cliente para anular el abono</a>
        : 'Pídele a un administrador (con permiso para anular abonos) que lo anule desde la ficha del cliente, y vuelve a intentarlo.'}
    </p>
  )
}
