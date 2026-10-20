import type { Role } from '@/generated/prisma/enums'
import { permisosDeRol } from '@/lib/permisos'
import { permisosDe } from '@/lib/puede'
import type { TenantContext } from '@/lib/tenant-context'

/**
 * Quién puede dar qué rol, y a quién puede tocar.
 *
 * ─── LA REGLA ────────────────────────────────────────────────────────────
 *
 * Nadie concede más poder del que tiene. «Poder» son los PERMISOS, no un
 * rango: un rol se puede dar solo si TODOS sus permisos están entre los del
 * que lo da. Así un ADMIN puede crear cajeros, vendedores, almaceneros,
 * contadores y otros administradores, pero no un DUEÑO (le faltan
 * `config.fiscal` y `plan.gestionar`), y la regla sigue valiendo el día que
 * cambie la matriz o un usuario acumule varios roles. Con una escalera de
 * rangos habría que acordarse de actualizarla.
 *
 * El DUEÑO no se concede por esta vía, ni siquiera el dueño: hay uno, y
 * traspasar la propiedad es una operación aparte, con sus propias
 * salvaguardas. SUPERADMIN pertenece a la plataforma, no a un negocio.
 */
const NO_CONCEDIBLES: ReadonlySet<Role> = new Set<Role>(['OWNER', 'SUPERADMIN'])

/** Los roles de un negocio que pueden concederse en algún caso. */
const ROLES_DEL_NEGOCIO: readonly Role[] = ['ADMIN', 'VENDEDOR', 'CAJERO', 'ALMACENERO', 'CONTADOR']

function contenidoEn(rol: Role, propios: ReadonlySet<string>): boolean {
  for (const p of permisosDeRol(rol)) if (!propios.has(p)) return false
  return true
}

/** Roles que `actor` puede conceder. */
export function rolesAsignables(actor: TenantContext): Role[] {
  const propios = permisosDe(actor)
  return ROLES_DEL_NEGOCIO.filter((r) => contenidoEn(r, propios))
}

/** ¿Puede `actor` conceder TODOS estos roles? */
export function puedeAsignar(actor: TenantContext, roles: readonly Role[]): boolean {
  const permitidos = new Set(rolesAsignables(actor))
  return roles.every((r) => !NO_CONCEDIBLES.has(r) && permitidos.has(r))
}

export interface UsuarioObjetivo {
  id: string
  role: Role
  extraRoles: readonly Role[]
}

/**
 * ¿Puede `actor` cambiar el rol de este usuario o desactivarlo?
 *
 *   · A sí mismo, no: quien se quita el rol o se desactiva se deja sin acceso
 *     o, peor, se sube el sueldo con la mano de otro.
 *   · Al dueño, no: nadie, ni él mismo por esta vía.
 *   · A quien tenga más poder que él, no: un ADMIN no puede degradar ni echar
 *     a alguien cuyos permisos él no alcanza.
 */
export function puedeGestionarA(actor: TenantContext, objetivo: UsuarioObjetivo): boolean {
  if (objetivo.id === actor.userId) return false
  const roles = [objetivo.role, ...objetivo.extraRoles]
  if (roles.some((r) => NO_CONCEDIBLES.has(r))) return false
  const propios = permisosDe(actor)
  return roles.every((r) => contenidoEn(r, propios))
}

/**
 * ¿Puede `actor` poner la contraseña de este usuario?
 *
 *   · La suya propia: sí. Es el único caso en que el DUEÑO entra en la
 *     regla: cualquier otra persona que toque la clave del dueño tendría su
 *     cuenta, y con ella el negocio entero.
 *   · La de otro: solo si `puedeGestionarA`, es decir, si ese usuario tiene
 *     MENOS poder que él. Nadie cambia la clave de un dueño, de un
 *     superadmin ni de alguien con permisos que él no alcanza (un ADMIN no
 *     puede cambiarle la clave a otro ADMIN con más poder, ni a un DUEÑO).
 */
export function puedeCambiarPassword(actor: TenantContext, objetivo: UsuarioObjetivo): boolean {
  if (objetivo.id === actor.userId) return true
  return puedeGestionarA(actor, objetivo)
}
