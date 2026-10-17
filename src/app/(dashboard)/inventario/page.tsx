import Link from 'next/link'
import { requireTenantContext } from '@/lib/session'
import { ScanToStockSheet } from '@/features/inventory/components/ScanToStockSheet'

export const dynamic = 'force-dynamic'

/**
 * Inventario.
 *
 * Verifica la sesión contra la BASE aunque esta pantalla no consulte datos
 * propios, y hay dos razones:
 *
 *   1. Desde que el proxy decide solo con el token (ver src/proxy.ts), el
 *      enforcement vive en el render. Depender de que lo haga el layout
 *      funciona hoy, pero deja la garantía a distancia: mover el archivo o
 *      tocar el layout abriría la página sin que nada avisara.
 *   2. `requireTenantContext` está memoizado por render, así que esta llamada
 *      NO añade una consulta: comparte la del layout.
 *
 * `tests/proxy-sin-bd.ts` hace fallar la suite si una página privada se la
 * salta — y fue esa prueba la que detectó que aquí faltaba.
 */
export default async function InventarioPage() {
  await requireTenantContext()

  return (
    <main className="mx-auto flex max-w-lg flex-col gap-6 p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">Inventario</h1>
          <p className="text-sm text-ink-muted">
            Escanea un código para registrar entradas, salidas o ajustes.
          </p>
        </div>
        <Link
          href="/inventario/importar"
          className="h-touch-lg shrink-0 inline-flex items-center rounded-xl border border-hairline px-4 text-sm font-semibold text-ink"
        >
          Importar catálogo
        </Link>
      </header>
      <ScanToStockSheet />
    </main>
  )
}
