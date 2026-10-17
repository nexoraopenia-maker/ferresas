'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useOptimistic, useTransition } from 'react'
import { isActive, visibleItems } from '../nav-items'

/**
 * Enlaces de navegación, con marcado ACTIVO OPTIMISTA.
 *
 * ─── EL PROBLEMA QUE RESUELVE ────────────────────────────────────────────
 *
 * `usePathname()` solo cambia cuando la navegación ya se ha COMPLETADO. Y
 * estas rutas son `force-dynamic`: el servidor tiene que resolver sesión y
 * consultar la base antes de devolver nada. Entre el clic y ese momento, el
 * menú seguía mostrando como activa la sección ANTERIOR.
 *
 * Para quien usa el sistema eso no se lee como "está cargando": se lee como
 * "mi clic no hizo nada", y la reacción natural es volver a pulsar. De ahí
 * que el remedio no sea solo poner un spinner en la página destino, sino
 * mover el marcado del menú al instante.
 *
 * `useOptimistic` mueve el resaltado en el mismo frame del clic y React lo
 * revierte solo si la navegación se cancela o falla. No hay que limpiar
 * estado a mano, que es donde este patrón se suele romper.
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
  const router = useRouter()
  const items = visibleItems(role)
  const [pending, startTransition] = useTransition()
  const [destino, marcarDestino] = useOptimistic(pathname)

  const navegar = (href: string) => (e: React.MouseEvent) => {
    /*
     * Se respetan los gestos del navegador: ctrl/cmd-clic para abrir en
     * pestaña nueva, clic central, etc. Si se interceptaran, el usuario
     * perdería una función que ya tenía — y perder capacidades a cambio de
     * un resaltado más rápido es un mal canje.
     */
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
    e.preventDefault()
    startTransition(() => {
      marcarDestino(href)
      router.push(href)
    })
  }

  const esActivo = (href: string) => isActive(href, destino)

  if (variant === 'bottom') {
    return (
      <>
        {items.map((i) => {
          const activo = esActivo(i.href)
          const cargando = pending && activo && !isActive(i.href, pathname)
          return (
            <Link
              key={i.href}
              href={i.href}
              onClick={navegar(i.href)}
              aria-current={activo ? 'page' : undefined}
              aria-busy={cargando || undefined}
              className={`flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-xl py-1.5 transition-colors ${
                activo ? 'text-industrial-600 dark:text-industrial-400' : 'text-ink-muted'
              }`}
            >
              <Icono d={i.icon} activo={activo} cargando={cargando} />
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
        const activo = esActivo(i.href)
        const cargando = pending && activo && !isActive(i.href, pathname)
        return (
          <Link
            key={i.href}
            href={i.href}
            onClick={navegar(i.href)}
            aria-current={activo ? 'page' : undefined}
            aria-busy={cargando || undefined}
            className={`flex h-touch-lg items-center gap-3 rounded-xl px-3 text-sm font-semibold transition-colors ${
              activo
                ? 'bg-industrial-600 text-white'
                : 'text-ink hover:bg-surface-sunken'
            }`}
          >
            <Icono d={i.icon} activo={activo} cargando={cargando} />
            <span className="truncate">{i.label}</span>
          </Link>
        )
      })}
    </>
  )
}

function Icono({
  d,
  activo,
  cargando,
}: {
  d: string
  activo: boolean
  cargando?: boolean
}) {
  /*
   * Mientras la navegación está en vuelo, el icono se sustituye por un
   * spinner. Es la señal de que el clic SÍ se registró, y aparece en el mismo
   * frame porque no depende de ninguna respuesta del servidor.
   */
  if (cargando) {
    return (
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.2}
        strokeLinecap="round"
        className="size-5 shrink-0 animate-spin"
      >
        <path d="M12 3a9 9 0 1 0 9 9" />
      </svg>
    )
  }
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
