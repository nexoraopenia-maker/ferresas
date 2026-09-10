import { ScanToStockSheet } from '@/features/inventory/components/ScanToStockSheet'

export default function InventarioPage() {
  return (
    <main className="mx-auto flex max-w-lg flex-col gap-6 p-4">
      <header>
        <h1 className="text-2xl font-bold text-ink">Inventario</h1>
        <p className="text-sm text-ink-muted">
          Escanea un código para registrar entradas, salidas o ajustes.
        </p>
      </header>
      <ScanToStockSheet />
    </main>
  )
}
