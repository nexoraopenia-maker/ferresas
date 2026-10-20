import { validarDocumento } from '@/lib/documentos'

/**
 * Consulta de contribuyentes (padrón) por DNI o RUC.
 *
 * Sirve para que el cajero escriba un documento y el nombre (y la dirección,
 * si hay) aparezcan solos, y para que una factura salga a nombre de la razón
 * social REAL y no de lo que se tecleó.
 *
 * ⚠️ NORMATIVO / COMERCIAL: no hay ningún proveedor real conectado. Las
 * fuentes posibles —el padrón reducido de SUNAT, RENIEC por convenio o un
 * servicio de terceros de pago— exigen un contrato o una decisión que no es
 * técnica; ver docs/COMPLIANCE.md. Mientras tanto, la interfaz y el modo
 * `ninguno` (el de producción) dejan al cajero teclear el nombre como siempre.
 */

export interface DatosContribuyente {
  tipo: 'DNI' | 'RUC'
  numero: string
  nombre: string
  direccion: string | null
  /** Solo RUC: ACTIVO / BAJA… tal como lo informe la fuente. */
  estado: string | null
  /** Solo RUC: HABIDO / NO HABIDO… tal como lo informe la fuente. */
  condicion: string | null
}

export type ResultadoPadron =
  | { ok: true; datos: DatosContribuyente; fuente: string }
  | { ok: false; motivo: 'INVALIDO' | 'NO_ENCONTRADO' | 'NO_DISPONIBLE'; mensaje: string }

export interface ProveedorPadron {
  readonly nombre: string
  consultar(tipo: 'DNI' | 'RUC', numero: string): Promise<ResultadoPadron>
}

/** Producción hoy: no hay fuente, así que no se inventa nada. */
export const sinPadron: ProveedorPadron = {
  nombre: 'ninguno',
  async consultar() {
    return { ok: false, motivo: 'NO_DISPONIBLE', mensaje: 'No hay un servicio de consulta de padrón configurado.' }
  },
}

/**
 * Simulado, para desarrollo y la cuenta demo. Responde con datos OBVIAMENTE
 * ficticios y de forma determinista; los documentos que terminan en 0 «no
 * existen», para poder probar ese camino.
 */
export const padronMock: ProveedorPadron = {
  nombre: 'mock',
  async consultar(tipo, numero) {
    if (numero.endsWith('0')) {
      return { ok: false, motivo: 'NO_ENCONTRADO', mensaje: 'El documento no figura en el padrón.' }
    }
    return {
      ok: true,
      fuente: 'mock',
      datos: tipo === 'RUC'
        ? { tipo, numero, nombre: `EMPRESA DE PRUEBA ${numero.slice(-4)} S.A.C.`, direccion: 'AV. FICTICIA 123 - LIMA', estado: 'ACTIVO', condicion: 'HABIDO' }
        : { tipo, numero, nombre: `PERSONA DE PRUEBA ${numero.slice(-4)}`, direccion: null, estado: null, condicion: null },
    }
  },
}

const PROVEEDORES: Record<string, ProveedorPadron> = { ninguno: sinPadron, mock: padronMock }

export function obtenerProveedorPadron(nombre?: string): ProveedorPadron {
  const elegido = nombre ?? process.env.PADRON_PROVEEDOR ?? 'ninguno'
  const p = PROVEEDORES[elegido]
  if (!p) {
    throw new Error(`Proveedor de padrón desconocido: "${elegido}". Disponibles: ${Object.keys(PROVEEDORES).join(', ')}.`)
  }
  return p
}

/**
 * Valida el documento (formato y dígito verificador) y, si es posible, lo
 * consulta. Nunca lanza: un fallo de la fuente es `NO_DISPONIBLE`, no un error
 * que tire la venta.
 */
export async function consultarPadron(
  numero: string,
  proveedor: ProveedorPadron = obtenerProveedorPadron(),
): Promise<ResultadoPadron> {
  const v = validarDocumento(numero)
  if (!v.valido || !v.tipo) {
    return { ok: false, motivo: 'INVALIDO', mensaje: v.valido ? 'Documento no válido.' : v.mensaje }
  }
  try {
    return await proveedor.consultar(v.tipo, numero.trim())
  } catch {
    return { ok: false, motivo: 'NO_DISPONIBLE', mensaje: 'La consulta de padrón no respondió.' }
  }
}
