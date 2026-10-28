import type { Permiso } from '@/lib/permisos'
import { puede } from '@/lib/puede'
import type { TenantContext } from '@/lib/tenant-context'

/**
 * Quién puede VER el historial de ventas (`/ventas` y el detalle de cada venta). Lista pura, para que el servicio, las páginas, el menú y el
 * POS decidan por la MISMA: quien cobra (`ventas.cobrar`), quien anula (`ventas.anular`) y quien revisa reportes (`reportes.ver`: el contador
 * consulta sin poder tocar nada). Ver no concede ningún poder: anular o devolver es solo `ventas.anular`. Nunca muestra costos.
 */
export const PERMISOS_VER_VENTAS = ['ventas.cobrar', 'ventas.anular', 'reportes.ver'] as const satisfies readonly Permiso[]

export function puedeVerVentas(ctx: TenantContext): boolean {
  return PERMISOS_VER_VENTAS.some((p) => puede(ctx, p))
}
