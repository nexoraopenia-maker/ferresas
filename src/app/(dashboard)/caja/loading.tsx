import { Barra, CabeceraSkeleton, PantallaSkeleton } from '@/features/shell/components/Skeleton'

export default function Loading() {
  return (
    <PantallaSkeleton ancho="max-w-2xl">
      <CabeceraSkeleton />
      <div className="rounded-2xl border border-hairline bg-surface p-5">
        <Barra className="h-3 w-24" />
        <Barra className="mt-2 h-6 w-36" />
        <div className="mt-4 grid grid-cols-2 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i}>
              <Barra className="h-3 w-20" />
              <Barra className="mt-1.5 h-4 w-24" />
            </div>
          ))}
        </div>
      </div>
      <Barra className="h-48 w-full rounded-2xl" />
    </PantallaSkeleton>
  )
}
