import { puede } from '@/lib/puede'
import type { TenantContext } from '@/lib/tenant-context'
import { PERMISOS_VER_CLIENTES } from './permisos'

/** ¿Puede este usuario ver clientes (lista, ficha, estado de cuenta, recibos de abono)? Una sola definición, sobre la lista pura. */
export function puedeVerClientes(ctx: TenantContext): boolean {
  return PERMISOS_VER_CLIENTES.some((p) => puede(ctx, p))
}
