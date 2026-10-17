import { Barra, CabeceraSkeleton, ListaSkeleton, PantallaSkeleton } from '@/features/shell/components/Skeleton'

/** «Mi plan»: estado de la suscripción y las tarjetas de planes. */
export default function Loading() {
  return (
    <PantallaSkeleton ancho="max-w-2xl">
      <CabeceraSkeleton />
      <div className="rounded-2xl border border-hairline bg-surface p-5">
        <Barra className="h-4 w-28" />
        <Barra className="mt-3 h-6 w-40" />
        <Barra className="mt-2 h-3 w-56" />
      </div>
      <ListaSkeleton n={3} alto="h-32" />
    </PantallaSkeleton>
  )
}
