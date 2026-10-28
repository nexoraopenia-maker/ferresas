import type { InventoryCountItemStatus, InventoryCountMode, InventoryCountScope, InventoryCountStatus, UnitType } from '@/generated/prisma/enums'
import { tieneMaxDecimales } from '@/lib/dinero'
import { ConversionInvalida, convertirCantidad, decimalesPermitidos } from './conversion'
import { LARGO_MAXIMO_ZONA } from './conteo-schemas'
import type { AlertaLinea } from './conteo-revision'

/**
 * Lo PURO de las pantallas de la toma de inventario (F6.5c): nombres en cristiano, enlaces, qué acciones se ofrecen según el estado y los permisos, y la comprobación en vivo
 * de una pasada. Sin React ni base de datos, para probarlo a fondo. Lo que aquí se ofrece es solo comodidad: el servidor vuelve a comprobar TODO.
 */

export const ETIQUETA_ESTADO: Record<InventoryCountStatus, string> = {
  BORRADOR: 'Borrador', EN_CONTEO: 'En conteo', EN_REVISION: 'En revisión', APLICADO: 'Aplicado', CANCELADO: 'Cancelado',
}
export const ETIQUETA_ALCANCE: Record<InventoryCountScope, string> = { TOTAL: 'Todo el almacén', CATEGORIA: 'Por categoría', SELECCION: 'Selección de productos' }
export const ETIQUETA_MODO: Record<InventoryCountMode, string> = { CIEGO: 'Ciego', GUIADO: 'Guiado' }
export const ETIQUETA_ESTADO_LINEA: Record<InventoryCountItemStatus, string> = { PENDIENTE: 'Sin contar', CONTADO: 'Contada', RECONTAR: 'Por recontar', APROBADO: 'Aprobada', RECHAZADO: 'Rechazada' }
export const ETIQUETA_ALERTA: Record<AlertaLinea, string> = {
  SOBRE_UMBRAL: 'Diferencia grande: conviene recontar',
  SIN_COSTO: 'Producto sin costo',
  MOVIDO_DESPUES: 'Se movió después de contar',
  DEJARIA_NEGATIVO: 'Dejaría el stock en negativo',
}
export const AYUDA_MODO: Record<InventoryCountMode, string> = {
  CIEGO: 'Quien cuenta no ve lo que dice el sistema: así cuenta lo que hay, no lo que espera encontrar.',
  GUIADO: 'Quien cuenta ve lo que dice el sistema. Útil para supervisar, pero invita a copiar la cifra.',
}

export const enlaceConteos = (): string => '/inventario/conteos'
export const enlaceConteo = (id: string): string => `/inventario/conteos/${encodeURIComponent(id)}`
export const enlaceContar = (id: string): string => `${enlaceConteo(id)}/contar`
export const enlaceRevision = (id: string, f: { estado?: string; cursor?: string } = {}): string => {
  const q = [f.estado ? `estado=${encodeURIComponent(f.estado)}` : '', f.cursor ? `cursor=${encodeURIComponent(f.cursor)}` : ''].filter(Boolean).join('&')
  return `${enlaceConteo(id)}/revision${q ? `?${q}` : ''}`
}
export const enlaceActa = (id: string, opts: { todo?: boolean; auto?: boolean } = {}): string => {
  const q = [opts.todo ? 'detalle=todo' : '', opts.auto ? 'auto=1' : ''].filter(Boolean).join('&')
  return `/imprimir/acta-conteo/${encodeURIComponent(id)}${q ? `?${q}` : ''}`
}
export const enlaceCsvConteo = (id: string): string => `/api/inventario/conteos/${encodeURIComponent(id)}`

// ─── Qué se ofrece ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface PermisosConteo {
  /** `conteo.gestionar` */ gestionar: boolean
  /** `conteo.registrar` */ registrar: boolean
  /** `stock.ajustar` (sin PIN de operador) */ aprobar: boolean
  /** ¿ve las diferencias? (`stock.ajustar` o `conteo.gestionar`) */ verRevision: boolean
}

export interface AccionesConteo {
  iniciar: boolean
  cerrar: boolean
  cancelar: boolean
  contar: boolean
  verRevision: boolean
  decidir: boolean
  acta: boolean
  csv: boolean
}

/** Qué botones se ofrecen según el estado del conteo y los permisos de la persona. El servidor decide de verdad; esto solo evita ofrecer lo que va a fallar. */
export function accionesDisponibles(estado: InventoryCountStatus, p: PermisosConteo, hay: { porRecontar: boolean; aplicadas: boolean }): AccionesConteo {
  const abierto = estado === 'BORRADOR' || estado === 'EN_CONTEO' || estado === 'EN_REVISION'
  return {
    iniciar: estado === 'BORRADOR' && p.gestionar,
    cerrar: estado === 'EN_CONTEO' && p.gestionar,
    cancelar: abierto && p.gestionar && !hay.aplicadas,
    contar: p.registrar && (estado === 'EN_CONTEO' || (estado === 'EN_REVISION' && hay.porRecontar)),
    verRevision: p.verRevision && (estado === 'EN_CONTEO' || estado === 'EN_REVISION' || estado === 'APLICADO'),
    decidir: p.aprobar && estado === 'EN_REVISION',
    acta: p.verRevision && (estado === 'EN_REVISION' || estado === 'APLICADO'),
    csv: p.verRevision && (estado === 'EN_CONTEO' || estado === 'EN_REVISION' || estado === 'APLICADO'),
  }
}

export interface PresentacionElegible { id: string; nombre: string; unidad: UnitType; factor: string }

export interface EvaluacionPasada {
  ok: boolean
  errores: string[]
  /** La cantidad en unidad base (la que cuenta); `null` si lo tecleado no vale. */
  cantidadBase: number | null
  presentationId: string | null
  enteredQuantity: string | null
  zona: string | undefined
}

/**
 * Comprueba EN VIVO lo que la persona va a registrar: la cantidad (coma o punto), que respete las fracciones de la unidad, la conversión de cajas × factor con la misma
 * función exacta que usa el servidor, y la zona. Contar CERO es válido; con una presentación elegida, un cero se manda en unidad base (cero cajas = cero unidades).
 */
export function evaluarPasada(e: { cantidad: string; unidad: UnitType; presentacion: PresentacionElegible | null; zona: string }): EvaluacionPasada {
  const errores: string[] = []
  const texto = e.cantidad.trim().replace(',', '.')
  const zona = e.zona.trim()
  if (zona.length > LARGO_MAXIMO_ZONA) errores.push(`La zona admite hasta ${LARGO_MAXIMO_ZONA} caracteres.`)
  const vacio: EvaluacionPasada = { ok: false, errores, cantidadBase: null, presentationId: null, enteredQuantity: null, zona: zona || undefined }
  if (texto === '') { errores.push('Escribe la cantidad contada (si no hay ninguno, escribe 0).'); return vacio }
  const n = Number(texto)
  if (!/^\d+(\.\d+)?$/.test(texto) || !Number.isFinite(n)) { errores.push('La cantidad debe ser un número, sin signo (por ejemplo 12 o 2.5).'); return vacio }
  if (n >= 1e9) { errores.push('La cantidad está fuera de rango.'); return vacio }

  if (e.presentacion && n > 0) {
    try {
      const c = convertirCantidad({ cantidadIngresada: texto, factor: e.presentacion.factor, unidadPresentacion: e.presentacion.unidad, unidadBase: e.unidad })
      return { ok: errores.length === 0, errores, cantidadBase: Number(c.cantidadBase), presentationId: e.presentacion.id, enteredQuantity: c.cantidadIngresada, zona: zona || undefined }
    } catch (x) {
      if (x instanceof ConversionInvalida) { errores.push(x.message); return vacio }
      throw x
    }
  }
  if (!tieneMaxDecimales(n, decimalesPermitidos(e.unidad))) {
    errores.push(decimalesPermitidos(e.unidad) === 0 ? `Este producto se cuenta en unidades enteras (${e.unidad}).` : `Este producto admite hasta ${decimalesPermitidos(e.unidad)} decimales (${e.unidad}).`)
    return vacio
  }
  return { ok: errores.length === 0, errores, cantidadBase: n, presentationId: null, enteredQuantity: null, zona: zona || undefined }
}
