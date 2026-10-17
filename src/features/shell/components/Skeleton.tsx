/**
 * Esqueletos de carga.
 *
 * ─── POR QUÉ CON LA FORMA DEL CONTENIDO REAL ─────────────────────────────
 *
 * Un esqueleto genérico (tres barras grises) avisa de que algo carga, pero el
 * contenido al llegar SALTA, porque no ocupa el mismo sitio. Ese salto se
 * percibe como lentitud aunque el tiempo total sea el mismo.
 *
 * Así que cada esqueleto imita la estructura de su pantalla: mismo número de
 * tarjetas, misma altura de cabecera, mismo ancho de columnas. El relleno se
 * sustituye por contenido sin que nada se mueva.
 *
 * Son Server Components puros, sin estado ni JS: se envían como HTML y
 * aparecen de inmediato, antes de que hidrate nada.
 */

/** Bloque gris con pulso. `w` y `h` en clases de Tailwind. */
export function Barra({ className = '' }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={`animate-pulse rounded-md bg-surface-sunken ${className}`}
    />
  )
}

/** Cabecera de pantalla: título y subtítulo. */
export function CabeceraSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      <Barra className="h-8 w-48" />
      <Barra className="h-4 w-72 max-w-full" />
    </div>
  )
}

/** Fila de tarjetas de contador. */
export function ContadoresSkeleton({ n = 3 }: { n?: number }) {
  return (
    <div className={`grid gap-3 ${n === 2 ? 'grid-cols-2' : n === 4 ? 'grid-cols-2 md:grid-cols-4' : 'grid-cols-3'}`}>
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className="rounded-2xl border border-hairline bg-surface p-4">
          <Barra className="h-3 w-20" />
          <Barra className="mt-2 h-7 w-12" />
        </div>
      ))}
    </div>
  )
}

/** Lista de tarjetas apiladas. */
export function ListaSkeleton({ n = 4, alto = 'h-24' }: { n?: number; alto?: string }) {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className={`rounded-xl border border-hairline bg-surface ${alto} p-3`}>
          <Barra className="h-4 w-1/3" />
          <Barra className="mt-2 h-3 w-1/2" />
        </div>
      ))}
    </div>
  )
}

/** Tabla con cabecera y filas. */
export function TablaSkeleton({ filas = 6 }: { filas?: number }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-hairline bg-surface">
      <div className="flex gap-4 border-b border-hairline bg-surface-sunken px-3 py-2">
        {['w-28', 'w-24', 'w-20', 'w-16'].map((w) => (
          <Barra key={w} className={`h-3 ${w}`} />
        ))}
      </div>
      {Array.from({ length: filas }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 border-b border-hairline px-3 py-3 last:border-0">
          <div className="flex-1">
            <Barra className="h-4 w-32" />
            <Barra className="mt-1.5 h-3 w-40" />
          </div>
          <Barra className="h-4 w-20" />
          <Barra className="h-6 w-16 rounded-full" />
        </div>
      ))}
    </div>
  )
}

/**
 * Envoltura común: mismo ancho máximo y mismo relleno que la pantalla real,
 * para que el contenido no se desplace al sustituir el esqueleto.
 */
export function PantallaSkeleton({
  ancho = 'max-w-3xl',
  children,
}: {
  ancho?: string
  children: React.ReactNode
}) {
  return (
    <main
      aria-busy="true"
      aria-label="Cargando"
      className={`mx-auto flex ${ancho} flex-col gap-5 p-4`}
    >
      {children}
    </main>
  )
}
