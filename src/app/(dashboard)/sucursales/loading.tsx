import { Barra, CabeceraSkeleton, ContadoresSkeleton, ListaSkeleton, PantallaSkeleton } from '@/features/shell/components/Skeleton'

export default function Loading() {
  return (
    <PantallaSkeleton>
      <CabeceraSkeleton />
      <ContadoresSkeleton n={2} />
      <Barra className="h-touch-lg w-44 rounded-xl" />
      <ListaSkeleton n={2} alto="h-36" />
    </PantallaSkeleton>
  )
}
