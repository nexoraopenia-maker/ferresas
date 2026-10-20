import { BusinessError } from './errors'
import { ETIQUETAS, permisosEfectivos, type Permiso } from './permisos'
import type { TenantContext } from './tenant-context'

/**
 * La ÚNICA función que decide permisos.
 *
 * ─── POR QUÉ UNA SOLA ────────────────────────────────────────────────────
 *
 * Antes había 29 sitios comparando `ctx.role` con `hasRole`. Repartido así,
 * la autorización tiene tres problemas:
 *
 *   1. No se puede leer. «¿Qué puede hacer un cajero?» exigía revisar 29
 *      archivos y reconstruirlo mentalmente.
 *   2. Se desincroniza. Un servicio nuevo copia el `hasRole` del de al lado
 *      y hereda su criterio aunque no sea el adecuado.
 *   3. Bloquea la evolución. Pasar a roles por sucursal exigiría repasar los
 *      29. Con una sola función, se cambia esta.
 *
 * `tests/permisos.ts` tiene una prueba por AST que falla si alguien vuelve a
 * usar `hasRole` o a comparar `ctx.role` fuera de aquí.
 *
 * ─── ESTO NO ES LA ÚNICA FRONTERA ────────────────────────────────────────
 *
 * `puede()` responde «¿tiene permiso?». NO responde «¿es su sucursal?» ni
 * «¿está su cuenta al día?». Eso lo siguen haciendo `requireBranch()` y
 * `getTenantPrisma()`. Un permiso concedido sobre la sucursal equivocada
 * sigue siendo un error, y lo ataja el filtro de sucursal, no esta función.
 */

/**
 * Permisos efectivos del contexto.
 *
 * Hoy se derivan del rol único. El día que un usuario pueda tener varios
 * roles o permisos extra concedidos por el dueño, solo cambia esta función:
 * de ahí que `permisosEfectivos` ya acepte una LISTA de roles y los extras.
 */
export function permisosDe(ctx: TenantContext): Set<Permiso> {
  return permisosEfectivos([ctx.role], ctx.permisosExtra ?? [], ctx.permisosDenegados ?? [])
}

/** ¿Puede el usuario de este contexto hacer esto? */
export function puede(ctx: TenantContext, permiso: Permiso): boolean {
  return permisosDe(ctx).has(permiso)
}

/** ¿Puede todos? Para operaciones que combinan dos capacidades. */
export function puedeTodo(ctx: TenantContext, ...permisos: Permiso[]): boolean {
  const tiene = permisosDe(ctx)
  return permisos.every((p) => tiene.has(p))
}

/** ¿Puede alguno? Para pantallas a las que se llega por varias vías. */
export function puedeAlguno(ctx: TenantContext, ...permisos: Permiso[]): boolean {
  const tiene = permisosDe(ctx)
  return permisos.some((p) => tiene.has(p))
}

/**
 * Exige el permiso o lanza.
 *
 * El mensaje nombra la CAPACIDAD, no el rol: «no tienes permiso para cobrar»
 * le dice al usuario qué pedir, mientras que «necesitas rol CAJERO» le obliga
 * a entender el modelo de roles para saber a quién acudir.
 */
export function exigir(ctx: TenantContext, permiso: Permiso): void {
  if (!puede(ctx, permiso)) {
    throw new BusinessError(
      'FORBIDDEN_ROLE',
      `No tienes permiso para: ${ETIQUETAS[permiso].toLowerCase()}.`,
      { permiso },
    )
  }
}
