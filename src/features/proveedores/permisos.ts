import type { Permiso } from '@/lib/permisos'
import { puede } from '@/lib/puede'
import type { TenantContext } from '@/lib/tenant-context'

/**
 * Quién puede VER los proveedores (lista y ficha). Lista pura, sin servidor, para que el servicio, las páginas y el menú decidan por la
 * MISMA. Gestionar (crear, editar, dar de baja) es solo `proveedores.gestionar`; quien registra compras o paga necesita ver a quién.
 */
export const PERMISOS_VER_PROVEEDORES = ['proveedores.gestionar', 'compras.registrar', 'proveedores.pagar'] as const satisfies readonly Permiso[]

export function puedeVerProveedores(ctx: TenantContext): boolean {
  return PERMISOS_VER_PROVEEDORES.some((p) => puede(ctx, p))
}
