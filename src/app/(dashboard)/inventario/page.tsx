import Link from 'next/link'
import { ScanToStockSheet } from '@/features/inventory/components/ScanToStockSheet'

export default function InventarioPage() {
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
