'use client'

import * as Primitive from '@radix-ui/react-dialog'

/**
 * Diálogo sobre Radix, con nuestros tokens.
 *
 * Reemplaza los modales que había escritos a mano con `fixed inset-0` y un
 * `onClick` en el fondo. Aquellos funcionaban para el ratón y fallaban en lo
 * demás: el foco se quedaba detrás del modal, el tabulador se escapaba al
 * contenido de abajo, Escape no cerraba y el lector de pantalla seguía
 * leyendo la página. Radix aporta foco atrapado, Escape, `aria-modal` y
 * devolver el foco al elemento que abrió el diálogo.
 */

export const Dialog = Primitive.Root
export const DialogTrigger = Primitive.Trigger
export const DialogClose = Primitive.Close

export function DialogContent({
  children,
  title,
  description,
  size = 'md',
}: {
  children: React.ReactNode
  title: string
  description?: string
  size?: 'sm' | 'md' | 'lg'
}) {
  const ancho = size === 'sm' ? 'max-w-sm' : size === 'lg' ? 'max-w-lg' : 'max-w-md'

  return (
    <Primitive.Portal>
      <Primitive.Overlay className="fixed inset-0 z-50 bg-graphite-950/70 backdrop-blur-sm" />
      <Primitive.Content
        className={`fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] ${ancho} -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl bg-surface p-5 shadow-2xl focus:outline-none`}
        style={{ maxHeight: 'calc(100dvh - 2rem)' }}
      >
        <Primitive.Title className="text-lg font-bold text-ink">{title}</Primitive.Title>
        {description && (
          <Primitive.Description className="mt-1 text-sm text-ink-muted">
            {description}
          </Primitive.Description>
        )}
        <div className="mt-4">{children}</div>
      </Primitive.Content>
    </Primitive.Portal>
  )
}

/** Fila de botones de un diálogo: cancelar a la izquierda, confirmar a la derecha. */
export function DialogFooter({ children }: { children: React.ReactNode }) {
  return <div className="mt-4 flex gap-2">{children}</div>
}
