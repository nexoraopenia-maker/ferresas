import { Barra, CabeceraSkeleton, ContadoresSkeleton, PantallaSkeleton } from '@/features/shell/components/Skeleton'

export default function Loading() {
  return (
    <PantallaSkeleton ancho="max-w-5xl">
      <CabeceraSkeleton />
      <ContadoresSkeleton n={3} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Barra className="h-56 w-full rounded-2xl" />
        <Barra className="h-56 w-full rounded-2xl" />
      </div>
    </PantallaSkeleton>
  )
}
