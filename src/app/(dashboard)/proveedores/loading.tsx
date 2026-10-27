import { CabeceraSkeleton, ListaSkeleton, PantallaSkeleton } from '@/features/shell/components/Skeleton'

export default function Loading() {
  return (
    <PantallaSkeleton ancho="max-w-3xl">
      <CabeceraSkeleton />
      <ListaSkeleton n={6} alto="h-20" />
    </PantallaSkeleton>
  )
}
