import type { Permiso } from '@/lib/permisos'
import { puede } from '@/lib/puede'
import type { TenantContext } from '@/lib/tenant-context'

/**
 * Quién puede VER las cuentas por pagar (antigüedad, estado de cuenta de un proveedor y sus descargas). Lista pura, sin servidor, para que
 * el servicio, las páginas y el menú decidan por la MISMA. Es lo que ve proveedores, más `reportes.ver`: el contador revisa la deuda con
 * los proveedores sin poder pagar ni editar nada. Pagar es solo `proveedores.pagar`.
 */
export const PERMISOS_VER_POR_PAGAR = ['proveedores.gestionar', 'compras.registrar', 'proveedores.pagar', 'reportes.ver'] as const satisfies readonly Permiso[]

export function puedeVerPorPagar(ctx: TenantContext): boolean {
  return PERMISOS_VER_POR_PAGAR.some((p) => puede(ctx, p))
}
