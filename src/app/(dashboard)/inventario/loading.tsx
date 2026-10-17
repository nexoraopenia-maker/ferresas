import { Barra, CabeceraSkeleton, PantallaSkeleton } from '@/features/shell/components/Skeleton'

export default function Loading() {
  return (
    <PantallaSkeleton ancho="max-w-lg">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <CabeceraSkeleton />
        <Barra className="h-touch-lg w-40 rounded-xl" />
      </div>
      <Barra className="h-touch-xl w-full rounded-2xl" />
      <Barra className="h-touch-lg w-full rounded-xl" />
    </PantallaSkeleton>
  )
}
