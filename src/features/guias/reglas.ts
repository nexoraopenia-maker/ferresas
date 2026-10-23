import type { CustomerDocType, GuideMotive, GuideTransportMode } from '@/generated/prisma/enums'
import { validarDni, validarRuc } from '@/lib/documentos'

/**
 * Reglas de la Guía de Remisión (puras, sin base de datos).
 *
 * ⚠️ Los CÓDIGOS de los catálogos de SUNAT están aquí tal como los conoce el
 * equipo, pero NO se han contrastado con la fuente oficial vigente: ver
 * `docs/COMPLIANCE.md` §7. Hasta confirmarlos, solo sirven para mostrar el
 * documento y para el día en que se conecte un proveedor; no se envían a nadie.
 */

export const MOTIVOS: Record<GuideMotive, { codigo: string; etiqueta: string }> = {
  VENTA: { codigo: '01', etiqueta: 'Venta' },
  COMPRA: { codigo: '02', etiqueta: 'Compra' },
  TRASLADO_ESTABLECIMIENTOS: { codigo: '04', etiqueta: 'Traslado entre establecimientos o almacenes de la misma empresa' },
  OTROS: { codigo: '13', etiqueta: 'Otros' },
}

export const MODALIDADES: Record<GuideTransportMode, { codigo: string; etiqueta: string }> = {
  PUBLICO: { codigo: '01', etiqueta: 'Transporte público (una empresa de transporte lleva la carga)' },
  PRIVADO: { codigo: '02', etiqueta: 'Transporte privado (con vehículo y conductor propios)' },
}

export const TIPOS_DOC_DESTINATARIO: readonly Exclude<CustomerDocType, 'SIN_DOCUMENTO'>[] = ['RUC', 'DNI', 'CE', 'PASAPORTE']
export const TIPOS_DOC_CONDUCTOR: readonly Exclude<CustomerDocType, 'SIN_DOCUMENTO' | 'RUC'>[] = ['DNI', 'CE', 'PASAPORTE']

export const ETIQUETA_DOC: Record<CustomerDocType, string> = {
  DNI: 'DNI', RUC: 'RUC', CE: 'Carné de extranjería', PASAPORTE: 'Pasaporte', SIN_DOCUMENTO: 'Sin documento',
}

/** Ubigeo INEI: seis dígitos. Solo se valida el FORMATO: el catálogo oficial no está embarcado (ver COMPLIANCE §5). */
export const esUbigeoValido = (u: string) => /^\d{6}$/.test(u)

/** Placa: seis o siete letras/números, sin guion ni espacios. */
export const normalizarPlaca = (p: string) => p.toUpperCase().replace(/[\s-]/g, '')
export const esPlacaValida = (p: string) => /^[A-Z0-9]{6,7}$/.test(normalizarPlaca(p))

/** ⚠️ Formato de licencia sin confirmar: se exige solo que parezca un código (8 a 12 letras/números). */
export const normalizarLicencia = (l: string) => l.toUpperCase().replace(/[\s-]/g, '')
export const esLicenciaValida = (l: string) => /^[A-Z0-9]{8,12}$/.test(normalizarLicencia(l))

/** Valida un número de documento según su tipo. Devuelve el mensaje de error o null. */
export function errorDeDocumento(tipo: CustomerDocType, numero: string): string | null {
  const n = numero.trim()
  if (tipo === 'RUC') { const r = validarRuc(n); return r.valido ? null : r.mensaje ?? 'RUC inválido.' }
  if (tipo === 'DNI') { const r = validarDni(n); return r.valido ? null : r.mensaje ?? 'DNI inválido.' }
  if (tipo === 'SIN_DOCUMENTO') return 'Una guía exige el documento del destinatario.'
  return /^[A-Za-z0-9]{4,20}$/.test(n) ? null : 'El documento debe tener entre 4 y 20 letras o números.'
}

/**
 * Cuánto falta por despachar de cada producto: vendido (o enviado) menos lo ya
 * cubierto por guías vigentes. Una guía anulada no cuenta.
 */
export function pendientePorProducto(
  origen: ReadonlyMap<string, number>,
  despachado: ReadonlyMap<string, number>,
): Map<string, number> {
  const r = new Map<string, number>()
  for (const [id, cant] of origen) {
    const falta = Math.round((cant - (despachado.get(id) ?? 0)) * 10_000) / 10_000
    r.set(id, falta > 0 ? falta : 0)
  }
  return r
}
