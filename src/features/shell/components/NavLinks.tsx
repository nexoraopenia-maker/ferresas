'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { isActive, visibleItems } from '../nav-items'

/**
 * Enlaces de navegación. Cliente porque necesita `usePathname()` para marcar
 * el activo — es lo único que no puede resolverse en el servidor.
 *
 * Dos presentaciones del MISMO origen de datos:
 *   `sidebar`  columna de escritorio, con etiqueta larga
 *   `bottom`   barra inferior de móvil, icono sobre etiqueta corta
 */
export function NavLinks({
  variant,
  role,
}: {
  variant: 'sidebar' | 'bottom'
  role: string
}) {
  const pathname = usePathname()
  const items = visibleItems(role)

  if (variant === 'bottom') {
    return (
      <>
        {items.map((i) => {
          const activo = isActive(i.href, pathname)
          return (
            <Link
              key={i.href}
              href={i.href}
              aria-current={activo ? 'page' : undefined}
              className={`flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-xl py-1.5 ${
                activo ? 'text-industrial-600 dark:text-industrial-400' : 'text-ink-muted'
              }`}
            >
              <Icono d={i.icon} activo={activo} />
              <span className="text-[0.6875rem] font-bold leading-none">{i.short}</span>
            </Link>
          )
        })}
      </>
    )
  }

  return (
    <>
      {items.map((i) => {
        const activo = isActive(i.href, pathname)
        return (
          <Link
            key={i.href}
            href={i.href}
            aria-current={activo ? 'page' : undefined}
            className={`flex h-touch-lg items-center gap-3 rounded-xl px-3 text-sm font-semibold transition ${
              activo
                ? 'bg-industrial-600 text-white'
                : 'text-ink hover:bg-surface-sunken'
            }`}
          >
            <Icono d={i.icon} activo={activo} />
            <span className="truncate">{i.label}</span>
          </Link>
        )
      })}
    </>
  )
}

function Icono({ d, activo }: { d: string; activo: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={activo ? 2.2 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-5 shrink-0"
    >
      <path d={d} />
    </svg>
  )
}
