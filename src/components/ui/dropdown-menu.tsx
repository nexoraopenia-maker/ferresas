'use client'

import * as Primitive from '@radix-ui/react-dropdown-menu'

/**
 * Menú desplegable sobre Radix, vestido con NUESTROS tokens.
 *
 * ─── POR QUÉ RADIX Y NO UN <div> CON useState ─────────────────────────────
 *
 * Un menú hecho a mano parece funcionar y falla en todo lo que no se ve:
 * no atrapa el foco, no se cierra con Escape, no navega con flechas, no
 * anuncia su estado a un lector de pantalla y se sale de la pantalla cuando
 * la fila está al fondo de la tabla. Radix resuelve esas cinco cosas y no
 * impone ningún estilo, así que el sistema visual sigue siendo el nuestro:
 * aquí solo se añaden clases de `industrial-*`, `graphite-*` y `h-touch`.
 *
 * No se instaló shadcn/ui a propósito: habría traído su propia escala de
 * colores y radios, y tendríamos dos sistemas de diseño compitiendo.
 */

export const DropdownMenu = Primitive.Root
export const DropdownMenuTrigger = Primitive.Trigger

export function DropdownMenuContent({
  children,
  align = 'end',
}: {
  children: React.ReactNode
  align?: 'start' | 'center' | 'end'
}) {
  return (
    <Primitive.Portal>
      <Primitive.Content
        align={align}
        sideOffset={6}
        // `collisionPadding` evita que el menú de la última fila quede
        // cortado por el borde inferior de la ventana.
        collisionPadding={12}
        className="z-50 min-w-56 overflow-hidden rounded-xl border border-hairline bg-surface p-1 shadow-2xl"
      >
        {children}
      </Primitive.Content>
    </Primitive.Portal>
  )
}

export function DropdownMenuLabel({ children }: { children: React.ReactNode }) {
  return (
    <Primitive.Label className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">
      {children}
    </Primitive.Label>
  )
}

export function DropdownMenuSeparator() {
  return <Primitive.Separator className="my-1 h-px bg-hairline" />
}

export function DropdownMenuItem({
  children,
  onSelect,
  tone = 'normal',
  disabled,
}: {
  children: React.ReactNode
  onSelect?: () => void
  /** `danger` para lo destructivo; `ok` para lo que restaura. */
  tone?: 'normal' | 'danger' | 'ok'
  disabled?: boolean
}) {
  const color =
    tone === 'danger' ? 'text-stock-out data-highlighted:bg-stock-out-soft'
    : tone === 'ok' ? 'text-stock-ok data-highlighted:bg-stock-ok-soft'
    : 'text-ink data-highlighted:bg-surface-sunken'

  return (
    <Primitive.Item
      disabled={disabled}
      // Radix llama a onSelect también con Enter y Espacio, no solo con
      // clic: el menú es operable sin ratón sin escribir nada extra.
      onSelect={onSelect}
      className={`flex h-touch cursor-pointer select-none items-center gap-2 rounded-lg px-3 text-sm font-semibold outline-none data-disabled:pointer-events-none data-disabled:opacity-40 ${color}`}
    >
      {children}
    </Primitive.Item>
  )
}
