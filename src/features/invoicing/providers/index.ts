import type { ProveedorFacturacion } from './types'
import { proveedorMock } from './mock'
import { crearProveedorSunatDirecto } from '@/features/sunat/proveedor'

/**
 * Selección del proveedor de facturación.
 *
 * Un solo sitio donde se decide. Hoy hay dos: el `mock` (cuentas de demostración y pruebas) y `sunat-directo` (el sistema firma y envía directo a
 * SUNAT, sin intermediario). Añadir otro es crear `providers/<nombre>.ts` y registrarlo aquí; nada más del sistema cambia.
 *
 * Por defecto el mock, a propósito: emitir contra «nada» en silencio sería peor que emitir contra un simulador que al menos ejerce los caminos de
 * rechazo y reintento. Un negocio REAL nunca usa el mock: `elegirProveedor` (envio.ts) lo decide según el modo fiscal.
 */

const PROVEEDORES: Record<string, ProveedorFacturacion> = {
  mock: proveedorMock,
  'sunat-directo': crearProveedorSunatDirecto(),
}

export function obtenerProveedor(
  nombre?: string,
  opciones: { esDemo?: boolean } = {},
): ProveedorFacturacion {
  // Una cuenta de demostración NUNCA habla con un proveedor real, sea cual sea la configuración del entorno: sus comprobantes son de mentira.
  if (opciones.esDemo) return PROVEEDORES.mock!
  const elegido = nombre ?? process.env.FACTURACION_PROVEEDOR ?? 'mock'
  const p = PROVEEDORES[elegido]
  if (!p) {
    const disponibles = Object.keys(PROVEEDORES).join(', ')
    throw new Error(`Proveedor de facturación desconocido: "${elegido}". Disponibles: ${disponibles}.`)
  }
  return p
}

/** Nombres registrados, para la UI del Super Admin. */
export function proveedoresDisponibles(): string[] {
  return Object.keys(PROVEEDORES)
}

export * from './types'
export { ErrorConfiguracionProveedor } from './errores'
export { reiniciarMock } from './mock'
