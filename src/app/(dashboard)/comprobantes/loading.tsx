import { CabeceraSkeleton, ContadoresSkeleton, PantallaSkeleton, TablaSkeleton } from '@/features/shell/components/Skeleton'

export default function Loading() {
  return (
    <PantallaSkeleton ancho="max-w-4xl">
      <CabeceraSkeleton />
      <ContadoresSkeleton n={4} />
      <TablaSkeleton filas={6} />
    </PantallaSkeleton>
  )
}
