import { formatoDeDetector, lecturaValida, type FormatoLectura } from './codigos-barras'

/**
 * Motor de lectura por cámara (solo navegador).
 *
 * Dos caminos, el mismo contrato:
 *   1. `BarcodeDetector` NATIVO (Chrome/Edge/Samsung Internet en Android): lo
 *      hace el sistema, con aceleración y enfoque propios; es MUCHO más fiable
 *      y rápido que decodificar en JavaScript.
 *   2. ZXing de respaldo (iOS Safari, Firefox, navegadores sin la API).
 *
 * Ambos abren la cámara trasera con enfoque continuo cuando el dispositivo lo
 * soporta, y descartan lecturas con dígito de control inválido.
 */

export interface LectorCamara {
  stop(): void
  /** Solo si la cámara tiene linterna. */
  switchTorch?: (encendida: boolean) => Promise<void>
  motor: 'nativo' | 'zxing'
}

export interface DetectorLike {
  detect(fuente: unknown): Promise<Array<{ rawValue: string; format: string }>>
}
export interface DetectorCtor {
  new (opciones?: { formats?: string[] }): DetectorLike
  getSupportedFormats?: () => Promise<string[]>
}

export interface EntornoLector {
  getUserMedia: (c: MediaStreamConstraints) => Promise<MediaStream>
  BarcodeDetector?: DetectorCtor
  /** Respaldo ZXing: carga diferida para no meter 250 kB en el bundle de todas las rutas. */
  cargarZxing?: () => Promise<ZxingLike>
}

export type ZxingLike = (
  video: HTMLVideoElement,
  onCodigo: (texto: string, formato: FormatoLectura) => void,
) => Promise<{ stop(): void; switchTorch?: (on: boolean) => Promise<void> }>

export interface OpcionesLector {
  video: HTMLVideoElement
  onCodigo: (codigo: string, formato: FormatoLectura) => void
  /** Pausa entre intentos del lector nativo (ms). */
  intervaloMs?: number
  entorno?: EntornoLector
}

export const FORMATOS_FERRETERIA = [
  'ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'qr_code',
] as const

export const RESTRICCIONES_CAMARA: MediaStreamConstraints = {
  video: {
    // `ideal` y no `exact`: una laptop con una sola cámara degrada en vez de fallar.
    facingMode: { ideal: 'environment' },
    // Resolución alta: un EAN pequeño en un envase necesita píxeles para leerse.
    width: { ideal: 1920 },
    height: { ideal: 1080 },
  },
  audio: false,
}

function entornoReal(): EntornoLector {
  const w = window as unknown as { BarcodeDetector?: DetectorCtor }
  return {
    getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
    BarcodeDetector: w.BarcodeDetector,
    cargarZxing: cargarZxingReal,
  }
}

export async function iniciarLector(o: OpcionesLector): Promise<LectorCamara> {
  const env = o.entorno ?? entornoReal()

  let formatos: string[] = []
  if (env.BarcodeDetector?.getSupportedFormats) {
    try {
      const soportados = await env.BarcodeDetector.getSupportedFormats()
      formatos = FORMATOS_FERRETERIA.filter((f) => soportados.includes(f))
    } catch { /* sin lista: se usa el respaldo */ }
  }
  // Sin EAN-13 el lector nativo no sirve para una ferretería: se usa ZXing.
  if (env.BarcodeDetector && formatos.includes('ean_13')) return iniciarNativo(o, env, formatos)

  if (!env.cargarZxing) throw new Error('Sin lector disponible.')
  const arrancar = await env.cargarZxing()
  const zx = await arrancar(o.video, o.onCodigo)
  return { ...zx, motor: 'zxing' }
}

async function iniciarNativo(o: OpcionesLector, env: EntornoLector, formatos: string[]): Promise<LectorCamara> {
  const stream = await env.getUserMedia(RESTRICCIONES_CAMARA)
  const track = stream.getVideoTracks()[0]
  const detector = new env.BarcodeDetector!({ formats: formatos })

  // Enfoque continuo y linterna: solo si el dispositivo lo declara.
  const caps = (track?.getCapabilities?.() ?? {}) as Record<string, unknown>
  if (Array.isArray(caps.focusMode) && caps.focusMode.includes('continuous')) {
    await track?.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] }).catch(() => {})
  }
  const tieneLinterna = 'torch' in caps

  o.video.srcObject = stream
  await o.video.play().catch(() => {})

  let activo = true
  let temporizador: ReturnType<typeof setTimeout> | undefined
  const tick = async () => {
    if (!activo) return
    if (o.video.readyState >= 2) {
      try {
        for (const r of await detector.detect(o.video)) {
          const formato = formatoDeDetector(r.format)
          // Un dígito de control inválido es una lectura mala: se ignora y se sigue.
          if (lecturaValida(r.rawValue, formato)) { o.onCodigo(r.rawValue, formato); break }
        }
      } catch { /* un frame que falla no detiene el lector */ }
    }
    if (activo) temporizador = setTimeout(tick, o.intervaloMs ?? 100)
  }
  void tick()

  return {
    motor: 'nativo',
    stop() {
      activo = false
      clearTimeout(temporizador)
      stream.getTracks().forEach((t) => t.stop())
      o.video.srcObject = null
    },
    switchTorch: tieneLinterna
      ? async (on) => { await track?.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] }) }
      : undefined,
  }
}

const cargarZxingReal = async (): Promise<ZxingLike> => {
  const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] =
    await Promise.all([import('@zxing/browser'), import('@zxing/library')])
  const nombres = new Map<number, FormatoLectura>([
    [BarcodeFormat.EAN_13, 'ean_13'], [BarcodeFormat.EAN_8, 'ean_8'], [BarcodeFormat.UPC_A, 'upc_a'],
    [BarcodeFormat.UPC_E, 'upc_e'], [BarcodeFormat.CODE_128, 'code_128'], [BarcodeFormat.CODE_39, 'code_39'],
    [BarcodeFormat.ITF, 'itf'], [BarcodeFormat.QR_CODE, 'qr_code'],
  ])
  return async (video, onCodigo) => {
    const hints = new Map()
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [...nombres.keys()])
    hints.set(DecodeHintType.TRY_HARDER, true)
    const reader = new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 120, delayBetweenScanSuccess: 400 })
    const controls = await reader.decodeFromConstraints(RESTRICCIONES_CAMARA, video, (result) => {
      if (!result) return
      const formato = nombres.get(result.getBarcodeFormat()) ?? 'otro'
      if (lecturaValida(result.getText(), formato)) onCodigo(result.getText(), formato)
    })
    return controls
  }
}
