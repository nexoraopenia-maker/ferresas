import type { ProveedorFacturacion } from './types'
import { proveedorMock } from './mock'

/**
 * Selección del proveedor de facturación.
 *
 * Un solo sitio donde se decide. Añadir un PSE real es:
 *   1. crear `providers/<nombre>.ts` que exporte un `ProveedorFacturacion`
 *   2. registrarlo en el mapa de abajo
 *
 * Nada más del sistema cambia. Esa es la razón de ser de esta capa.
 *
 * Por defecto el mock, a propósito: mientras no haya contrato con un
 * proveedor, emitir contra "nada" en silencio sería peor que emitir contra un
 * simulador que al menos ejerce los caminos de rechazo y reintento.
 */

const PROVEEDORES: Record<string, ProveedorFacturacion> = {
  mock: proveedorMock,
}

export function obtenerProveedor(
  nombre?: string,
  opciones: { esDemo?: boolean } = {},
): ProveedorFacturacion {
  // Una cuenta de demostración NUNCA habla con un proveedor real, sea cual sea
  // la configuración del entorno: sus comprobantes son de mentira.
  if (opciones.esDemo) return PROVEEDORES.mock!
  const elegido = nombre ?? process.env.FACTURACION_PROVEEDOR ?? 'mock'
  const p = PROVEEDORES[elegido]
  if (!p) {
    const disponibles = Object.keys(PROVEEDORES).join(', ')
    throw new Error(
      `Proveedor de facturación desconocido: "${elegido}". Disponibles: ${disponibles}.`,
    )
  }
  return p
}

/** Nombres registrados, para la UI del Super Admin. */
export function proveedoresDisponibles(): string[] {
  return Object.keys(PROVEEDORES)
}

export * from './types'
export { reiniciarMock } from './mock'
