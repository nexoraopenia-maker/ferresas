import { CabeceraSkeleton, ListaSkeleton, PantallaSkeleton } from '@/features/shell/components/Skeleton'

export default function Loading() {
  return (
    <PantallaSkeleton ancho="max-w-2xl">
      <CabeceraSkeleton />
      <ListaSkeleton n={4} />
    </PantallaSkeleton>
  )
}
