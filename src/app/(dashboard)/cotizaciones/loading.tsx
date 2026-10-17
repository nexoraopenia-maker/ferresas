import { CabeceraSkeleton, ContadoresSkeleton, ListaSkeleton, PantallaSkeleton } from '@/features/shell/components/Skeleton'

export default function Loading() {
  return (
    <PantallaSkeleton>
      <CabeceraSkeleton />
      <ContadoresSkeleton n={3} />
      <ListaSkeleton n={4} alto="h-28" />
    </PantallaSkeleton>
  )
}
