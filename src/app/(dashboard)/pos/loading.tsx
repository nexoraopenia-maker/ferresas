import { Barra, CabeceraSkeleton, PantallaSkeleton } from '@/features/shell/components/Skeleton'

/** Imita el POS: cabecera, botón de escanear, buscador y carrito vacío. */
export default function Loading() {
  return (
    <PantallaSkeleton ancho="max-w-lg">
      <CabeceraSkeleton />
      <Barra className="h-touch-xl w-full rounded-2xl" />
      <Barra className="h-touch-lg w-full rounded-xl" />
      <div className="rounded-2xl border border-hairline bg-surface p-4">
        <Barra className="h-4 w-24" />
        <Barra className="mt-3 h-3 w-48" />
      </div>
      <Barra className="h-touch-xl w-full rounded-2xl" />
    </PantallaSkeleton>
  )
}
