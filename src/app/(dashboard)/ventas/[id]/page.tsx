import { notFound } from 'next/navigation'
import { requireTenantContext } from '@/lib/session'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { puede } from '@/lib/puede'
import { isBusinessError } from '@/lib/errors'
import { diagnosticarDevolucionParcial } from '@/features/devoluciones/parcial-service'
import { diagnosticarDevolucion } from '@/features/devoluciones/service'
import { puedeVerVentas } from '@/features/ventas/permisos'
import { obtenerVenta } from '@/features/ventas/service'
import { DetalleVenta } from '@/features/ventas/components/DetalleVenta'
import { FormularioDevolucion } from '@/features/ventas/components/FormularioDevolucion'
import { AyudaAbonos } from '@/features/ventas/components/AyudaAbonos'
import { FormularioDevolucionParcial } from '@/features/ventas/components/FormularioDevolucionParcial'

export const dynamic = 'force-dynamic'

/**
 * Detalle de una venta, con la acción de anular o devolver. Ver el detalle: `puedeVerVentas`. Anular o devolver: SOLO `ventas.anular`
 * (y no con el PIN de operador). Una venta que no existe, es de otro negocio o de una sucursal que el usuario no tiene es un 404.
 * Si la venta no se puede devolver, se dice por qué, con el camino para resolverlo.
 */
export default async function DetalleVentaPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireTenantContext()
  if (!puedeVerVentas(ctx)) notFound()
  const { id } = await params
  const db = getTenantPrisma(ctx)

  const venta = await obtenerVenta(db, ctx, id.slice(0, 64)).catch((e) => {
    if (isBusinessError(e) && (e.code === 'NOT_FOUND' || e.code === 'FORBIDDEN_ROLE')) return null
    throw e
  })
  if (!venta) notFound()

  let accion = null
  if (venta.estado === 'COMPLETADA') {
    if (puede(ctx, 'ventas.anular')) {
      const puedeOperar = ctx.access === 'FULL' || ctx.access === 'WARN'
      const dp = await diagnosticarDevolucionParcial(db, ctx, venta.id)
      // «Anular / devolver todo» (F6.1) solo mientras la venta no tenga ninguna devolución parcial: después, lo que falta se devuelve por líneas.
      const d = venta.parcial ? null : await diagnosticarDevolucion(db, ctx, venta.id)
      const ayuda = (codigo?: string) => (codigo === 'CREDIT_HAS_PAYMENTS' ? <AyudaAbonos clienteId={venta.cliente?.id ?? null} puedeAnularAbonos={puede(ctx, 'credito.castigar')} /> : null)
      const aviso = (marca: string, titulo: string, texto: string, codigo?: string) => (
        <section aria-label={titulo} data-devolucion={marca} data-codigo={codigo} role="alert" className="flex flex-col gap-1 rounded-2xl border-2 border-stock-low bg-stock-low-soft p-4 text-sm text-ink">
          <h2 className="text-base font-bold text-stock-low">{titulo}</h2>
          <p>{texto}</p>
          {ayuda(codigo)}
        </section>
      )
      accion = (
        <>
          {dp.bloqueo
            ? aviso('bloqueo', 'No se pueden devolver productos de esta venta todavía', dp.bloqueo.mensaje, dp.bloqueo.code)
            : <FormularioDevolucionParcial saleId={venta.id} numero={venta.numero} diagnostico={dp} puedeOperar={puedeOperar} ayudaAbonos={ayuda('CREDIT_HAS_PAYMENTS')} />}
          {d && (d.bloqueo
            ? aviso('bloqueo-total', 'Esta venta no se puede anular ni devolver entera todavía', d.bloqueo.mensaje, d.bloqueo.code)
            : (
              <FormularioDevolucion
                saleId={venta.id} numero={venta.numero} total={venta.total} pagadoNeto={d.pagadoNeto} hayTurnoAbierto={d.hayTurnoAbierto}
                reembolsosIniciales={d.reembolsos.map((r) => ({ mode: r.mode, method: r.method, amount: r.amount, reference: r.reference }))}
                comprobante={d.nota?.comprobante ?? null} deEnsayo={d.comprobanteDeEnsayo} cuentaACancelar={d.cuentaACancelar}
                puedeOperar={puedeOperar}
              />
            ))}
        </>
      )
    } else {
      accion = (
        <p data-devolucion="sin-permiso" className="rounded-xl bg-surface-sunken px-3 py-2 text-sm text-ink-muted">
          {ctx.operadorDe
            ? 'Con el PIN de operador no se puede anular ni devolver una venta: entra con tu propio usuario.'
            : 'Para anular o devolver esta venta pide a quien tenga ese permiso (dueño o administrador).'}
        </p>
      )
    }
  }

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-4 p-4">
      <DetalleVenta venta={venta} accion={accion} />
    </main>
  )
}
