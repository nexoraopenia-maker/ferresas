'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { LectorCamara } from '@/lib/lector-camara'

/**
 * Escáner de códigos de barras / QR — esqueleto de la Fase 3 (§5.1).
 *
 * DECISIONES QUE VALE LA PENA CONOCER:
 *
 * 1. @zxing/browser se importa con `await import()` DENTRO del efecto, no
 *    arriba. La librería pesa ~250 kB y toca APIs de navegador: si se importa
 *    estáticamente entra al bundle de toda la ruta y rompe el render en
 *    servidor. Así solo se descarga cuando el operario abre el escáner.
 *
 * 2. Se restringen los formatos a los que existen en una ferretería. ZXing
 *    prueba cada formato habilitado en cada frame; pasar de "todos" a estos
 *    ocho es la diferencia entre leer al instante y leer en tres segundos
 *    con un celular de gama baja, que es el hardware real del caso de uso.
 *
 * 3. Este componente NO consulta la base de datos. Solo emite el código por
 *    `onDetected`; la búsqueda del producto, el alta exprés y el movimiento
 *    de stock son Server Actions del padre. Mantener el escáner ignorante
 *    del dominio es lo que permite reusarlo en POS, conteo y recepción.
 *
 * 4. `onDetected` puede ser async y el escáner se PAUSA mientras resuelve.
 *    Sin eso, un código en cámara dispara 10 lecturas por segundo y con
 *    ellas 10 movimientos de stock.
 */

export interface InventoryScannerModalProps {
  open: boolean
  onClose: () => void
  /**
   * Recibe el código leído. Si devuelve una promesa, el escáner queda en
   * pausa hasta que resuelva (evita lecturas en ráfaga).
   */
  onDetected: (code: string) => void | Promise<void>
  title?: string
  hint?: string
  /**
   * `true` (por defecto): sigue escaneando tras cada lectura — para conteo
   * de inventario o carga de carrito.
   * `false`: se cierra tras la primera lectura — para buscar un producto.
   */
  continuous?: boolean
  /** Ignora relecturas del mismo código dentro de esta ventana (ms). */
  dedupeMs?: number
}

type ScannerState =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | { phase: 'scanning' }
  | { phase: 'busy' }
  | { phase: 'error'; kind: ScannerErrorKind; message: string }

type ScannerErrorKind =
  | 'INSECURE_CONTEXT'
  | 'PERMISSION_DENIED'
  | 'NO_CAMERA'
  | 'UNKNOWN'

const ERROR_COPY: Record<ScannerErrorKind, { title: string; body: string }> = {
  INSECURE_CONTEXT: {
    title: 'La cámara necesita HTTPS',
    body: 'Abre la app desde una dirección segura (https) para poder escanear.',
  },
  PERMISSION_DENIED: {
    title: 'Cámara bloqueada',
    body: 'Activa el permiso de cámara en los ajustes del navegador y vuelve a intentar.',
  },
  NO_CAMERA: {
    title: 'No encontramos cámara',
    body: 'Este dispositivo no tiene cámara disponible. Puedes escribir el código a mano.',
  },
  UNKNOWN: {
    title: 'No pudimos abrir la cámara',
    body: 'Vuelve a intentar o escribe el código a mano.',
  },
}

/** Feedback físico: en un almacén ruidoso, la vibración es lo que se percibe. */
function pulse() {
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    navigator.vibrate?.(60)
  }
}

export function InventoryScannerModal({
  open,
  onClose,
  onDetected,
  title = 'Escanear producto',
  hint = 'Apunta al código de barras',
  continuous = true,
  dedupeMs = 1500,
}: InventoryScannerModalProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const controlsRef = useRef<LectorCamara | null>(null)
  const lastScanRef = useRef<{ code: string; at: number } | null>(null)
  /** Evita procesar lecturas mientras `onDetected` sigue en vuelo. */
  const lockRef = useRef(false)

  const [state, setState] = useState<ScannerState>({ phase: 'idle' })
  const [torchOn, setTorchOn] = useState(false)
  const [manualCode, setManualCode] = useState('')
  const [lastCode, setLastCode] = useState<string | null>(null)
  const [motor, setMotor] = useState<'nativo' | 'zxing' | null>(null)

  const headingId = useId()

  const stop = useCallback(() => {
    controlsRef.current?.stop()
    controlsRef.current = null
    setTorchOn(false)
  }, [])

  const handleCode = useCallback(
    async (code: string) => {
      const now = Date.now()
      const last = lastScanRef.current

      // Anti-rebote: el mismo código frente a la cámara dispara ~10 lecturas/s.
      if (last && last.code === code && now - last.at < dedupeMs) return
      if (lockRef.current) return

      lockRef.current = true
      lastScanRef.current = { code, at: now }
      setLastCode(code)
      pulse()
      setState({ phase: 'busy' })

      try {
        await onDetected(code)
        if (!continuous) {
          onClose()
          return
        }
        setState({ phase: 'scanning' })
      } catch {
        // El error de negocio lo comunica el padre (§6.7); aquí solo se
        // reanuda para que el operario pueda seguir trabajando.
        setState({ phase: 'scanning' })
      } finally {
        lockRef.current = false
      }
    },
    [continuous, dedupeMs, onClose, onDetected],
  )

  // --- Arranque y parada de la cámara -------------------------------------
  useEffect(() => {
    if (!open) return

    let cancelled = false

    const start = async () => {
      setState({ phase: 'starting' })

      if (typeof window !== 'undefined' && !window.isSecureContext) {
        setState({
          phase: 'error',
          kind: 'INSECURE_CONTEXT',
          message: ERROR_COPY.INSECURE_CONTEXT.body,
        })
        return
      }

      if (!navigator.mediaDevices?.getUserMedia) {
        setState({ phase: 'error', kind: 'NO_CAMERA', message: ERROR_COPY.NO_CAMERA.body })
        return
      }

      try {
        // Carga diferida del motor: ver nota 1 de la cabecera.
        const { iniciarLector } = await import('@/lib/lector-camara')
        if (cancelled || !videoRef.current) return

        const lector = await iniciarLector({
          video: videoRef.current,
          // Las lecturas con dígito de control inválido ya vienen descartadas.
          onCodigo: (codigo) => void handleCode(codigo),
        })

        if (cancelled) {
          lector.stop()
          return
        }

        controlsRef.current = lector
        setMotor(lector.motor)
        setState({ phase: 'scanning' })
      } catch (err) {
        if (cancelled) return
        const name = err instanceof Error ? err.name : ''
        const kind: ScannerErrorKind =
          name === 'NotAllowedError' || name === 'SecurityError'
            ? 'PERMISSION_DENIED'
            : name === 'NotFoundError' || name === 'OverconstrainedError'
              ? 'NO_CAMERA'
              : 'UNKNOWN'
        setState({ phase: 'error', kind, message: ERROR_COPY[kind].body })
      }
    }

    void start()

    return () => {
      cancelled = true
      stop()
    }
  }, [open, handleCode, stop])

  // Cerrar con Escape (útil en el POS de escritorio).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Bloquea el scroll del fondo mientras el sheet está abierto.
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  const toggleTorch = useCallback(async () => {
    const controls = controlsRef.current
    if (!controls?.switchTorch) return
    try {
      await controls.switchTorch(!torchOn)
      setTorchOn((v) => !v)
    } catch {
      // La linterna es experimental y no existe en iOS Safari: se ignora
      // en silencio en lugar de mostrar un error que el operario no puede
      // resolver.
    }
  }, [torchOn])

  const submitManual = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      const code = manualCode.trim()
      if (!code) return
      setManualCode('')
      await handleCode(code)
    },
    [handleCode, manualCode],
  )

  if (!open) return null

  const isError = state.phase === 'error'
  const isLive = state.phase === 'scanning' || state.phase === 'busy'

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
    >
      {/* Fondo. Cierra al tocar fuera, pero el sheet ocupa casi toda la
          pantalla para que no se cierre por accidente con la mano. */}
      <div
        className="absolute inset-0 bg-graphite-950/80 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Bottom sheet: el contenido vive abajo, al alcance del pulgar. */}
      <div className="relative flex h-[92dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-sheet bg-surface shadow-2xl">
        <header className="flex items-center justify-between gap-3 border-b border-hairline px-4 py-3">
          <div className="min-w-0">
            <h2 id={headingId} className="truncate text-lg font-bold text-ink">
              {title}
            </h2>
            <p className="truncate text-sm text-ink-muted">{hint}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar escáner"
            className="grid size-touch shrink-0 place-items-center rounded-full bg-surface-sunken text-2xl leading-none text-ink transition active:scale-95"
          >
            ×
          </button>
        </header>

        {/* --- Visor ------------------------------------------------------- */}
        <div className="relative flex-1 bg-graphite-950">
          <video
            ref={videoRef}
            className="size-full object-cover"
            playsInline
            muted
            // Sin esto iOS abre el video a pantalla completa y rompe el sheet.
            autoPlay
          />

          {isLive && (
            <>
              {/* Mira de encuadre. `pointer-events-none` para no robar toques. */}
              <div className="pointer-events-none absolute inset-0 grid place-items-center">
                <div className="relative h-40 w-4/5 max-w-sm rounded-2xl border-2 border-industrial-500/80 shadow-[0_0_0_100vmax_rgba(2,6,23,0.55)]">
                  <span className="absolute inset-x-6 top-1/2 h-0.5 -translate-y-1/2 bg-industrial-500/90" />
                </div>
              </div>

              {/* Qué motor lee: sirve para diagnosticar en el celular. */}
              <span className="pointer-events-none absolute bottom-2 left-3 rounded bg-graphite-900/70 px-2 py-0.5 text-[10px] text-graphite-300">
                lector: {motor === 'nativo' ? 'nativo' : 'alternativo'}
              </span>

              {controlsRef.current?.switchTorch && (
                <button
                  type="button"
                  onClick={toggleTorch}
                  aria-pressed={torchOn}
                  aria-label={torchOn ? 'Apagar linterna' : 'Encender linterna'}
                  className={`absolute right-4 top-4 grid size-touch-lg place-items-center rounded-full text-xl transition active:scale-95 ${
                    torchOn
                      ? 'bg-industrial-500 text-graphite-950'
                      : 'bg-graphite-900/70 text-graphite-100'
                  }`}
                >
                  ⚡
                </button>
              )}
            </>
          )}

          {state.phase === 'starting' && (
            <div className="absolute inset-0 grid place-items-center bg-graphite-950">
              <p className="animate-pulse text-graphite-300">Abriendo cámara…</p>
            </div>
          )}

          {state.phase === 'busy' && (
            <div className="absolute inset-x-0 bottom-0 bg-industrial-600 px-4 py-2 text-center text-sm font-semibold text-white">
              Registrando {lastCode}…
            </div>
          )}

          {isError && (
            <div className="absolute inset-0 grid place-items-center bg-graphite-950 px-6 text-center">
              <div>
                <p className="text-lg font-bold text-graphite-50">
                  {ERROR_COPY[state.kind].title}
                </p>
                <p className="mt-2 text-sm text-graphite-400">{state.message}</p>
              </div>
            </div>
          )}
        </div>

        {/* --- Alternativa manual -------------------------------------------
            No es un extra: los códigos se borran, se mojan y se arrugan.
            Sin esta salida, el operario queda bloqueado. */}
        <form
          onSubmit={submitManual}
          className="safe-bottom border-t border-hairline bg-surface px-4 pt-3"
        >
          <label
            htmlFor={`${headingId}-manual`}
            className="text-sm font-medium text-ink-muted"
          >
            ¿No lee el código?
          </label>
          <div className="mt-2 flex gap-2">
            <input
              id={`${headingId}-manual`}
              value={manualCode}
              onChange={(e) => setManualCode(e.target.value)}
              // `inputMode` abre el teclado numérico sin bloquear los códigos
              // internos alfanuméricos que algunos tenants imprimen.
              inputMode="numeric"
              autoComplete="off"
              placeholder="Escribe el código"
              className="h-touch-lg min-w-0 flex-1 rounded-xl border border-hairline bg-surface-sunken px-4 text-base text-ink placeholder:text-ink-muted focus:border-industrial-600 focus:outline-none focus:ring-2 focus:ring-industrial-600/40"
            />
            <button
              type="submit"
              disabled={!manualCode.trim() || state.phase === 'busy'}
              className="h-touch-lg shrink-0 rounded-xl bg-industrial-600 px-6 text-base font-bold text-white transition active:scale-95 disabled:opacity-40"
            >
              Buscar
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default InventoryScannerModal
