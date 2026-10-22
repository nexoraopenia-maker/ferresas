import type { Role } from '@/generated/prisma/enums'
import { BusinessError } from './errors'
import { OPCIONALES, type Permiso } from './permisos'
import { redondearCentimos } from './dinero'
import { puede } from './puede'
import type { TenantContext } from './tenant-context'

/**
 * Topes de descuento por rol.
 *
 * Dos cosas distintas que antes estaban sin hacer:
 *
 *  1. `ventas.descuento` (el PERMISO de dar descuentos) no se comprobaba en
 *     ningún sitio: quien podía cobrar podía mandar el descuento que quisiera.
 *  2. El TOPE: cuánto, como % de la línea, puede dar cada rol.
 *
 * Sin fila de configuración: OWNER y ADMIN 100 %, todos los demás 0 %. El dueño
 * fija el tope de VENDEDOR, CAJERO y ADMIN (el suyo no se limita). Un tope > 0
 * para un rol cuyo permiso es OPCIONAL (VENDEDOR, CAJERO) lo ACTIVA: así no hay
 * un interruptor aparte que pueda quedar en un estado contradictorio.
 */

export type TopesDescuento = Partial<Record<Role, number>>

const TOPE_POR_DEFECTO: Record<Role, number> = {
  SUPERADMIN: 0, OWNER: 100, ADMIN: 100, VENDEDOR: 0, CAJERO: 0, ALMACENERO: 0, CONTADOR: 0,
}
/** Roles cuyo tope no se puede limitar. */
const SIN_LIMITE: ReadonlySet<Role> = new Set<Role>(['OWNER'])

export function topeDeRol(rol: Role, topes?: TopesDescuento): number {
  if (SIN_LIMITE.has(rol)) return 100
  const configurado = topes?.[rol]
  return configurado !== undefined ? configurado : TOPE_POR_DEFECTO[rol]
}

/** Con varios roles vale el más alto: los permisos se UNEN. */
export function topeDeRoles(roles: readonly Role[], topes?: TopesDescuento): number {
  return roles.reduce((max, r) => Math.max(max, topeDeRol(r, topes)), 0)
}

/** Permisos opcionales que activan los topes configurados (hoy, `ventas.descuento`). */
export function extrasPorTopes(roles: readonly Role[], topes?: TopesDescuento): Permiso[] {
  const activa = roles.some(
    (r) => (OPCIONALES[r] ?? []).includes('ventas.descuento') && topeDeRol(r, topes) > 0,
  )
  return activa ? ['ventas.descuento'] : []
}

/**
 * Cuánto puede descontar este contexto, en % de cada línea.
 *
 *  · Sin el permiso: 0.
 *  · Con `descuentoMaxPct` fijado (operador por PIN): ese valor.
 *  · Con la configuración del negocio (`topesDescuento`): el de sus roles.
 *  · Sin configuración (contextos que no vienen de una sesión): el permiso decide.
 */
export function topeDescuento(ctx: TenantContext): number {
  if (!puede(ctx, 'ventas.descuento')) return 0
  if (ctx.descuentoMaxPct !== undefined) return ctx.descuentoMaxPct
  if (!ctx.topesDescuento) return 100
  return topeDeRoles([ctx.role, ...(ctx.roles ?? [])], ctx.topesDescuento)
}

/**
 * Rechaza un descuento que el contexto no puede dar.
 *
 * El máximo permitido se redondea a céntimos igual que el cobro: con 5 % de
 * 33,33 el POS calcula 1,67 (1,6665 redondeado) y eso no debe fallar por una
 * milésima.
 */
export function validarDescuentoLinea(
  ctx: TenantContext,
  nombre: string,
  bruto: number,
  descuento: number,
): void {
  if (descuento <= 0) return
  const tope = topeDescuento(ctx)
  if (tope <= 0) {
    throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para dar descuentos.')
  }
  const maximo = redondearCentimos((bruto * tope) / 100)
  if (descuento > maximo) {
    throw new BusinessError(
      'FORBIDDEN_ROLE',
      `Tu rol puede dar hasta ${tope}% de descuento. «${nombre}» lleva más: el máximo es S/ ${maximo.toFixed(2)}.`,
      { tope, maximo },
    )
  }
}
