/**
 * Qué sucursal está operando el usuario.
 *
 * ─── POR QUÉ ES UNA FUNCIÓN PURA APARTE ──────────────────────────────────
 *
 * Elegir sucursal parece trivial hasta que hay que decidir qué pasa cuando
 * el usuario pide una a la que no pertenece. La respuesta correcta —ignorar
 * la petición y caer a una suya— es exactamente la clase de regla que
 * conviene tener aislada y con pruebas, porque si falla, un cajero emite con
 * la serie de otro establecimiento y los correlativos quedan contaminados.
 *
 * La petición del cliente (cookie del selector de sucursal) es una SUGERENCIA
 * y se valida contra lo asignado en la base. Nunca manda.
 */

export const BRANCH_COOKIE = 'fs_branch'

export interface BranchOption {
  id: string
  isDefault: boolean
  code: string
}

/**
 * Sucursales cuyos datos puede ver y tocar el usuario.
 *
 * Quien administra sucursales (`sucursales.gestionar`: dueño y administrador)
 * ve TODAS las activas del negocio: no tendría sentido que el dueño necesite
 * asignarse a cada local nuevo para poder mirarlo. El resto, solo las que
 * tiene asignadas. Sin asignaciones, la lista queda vacía y el filtro del
 * cliente aislado no deja pasar nada: lo seguro es no ver, no ver todo.
 */
export function sucursalesPermitidas<T extends BranchOption>(
  asignadas: readonly T[],
  todasActivas: readonly T[],
  veTodas: boolean,
): T[] {
  return [...(veTodas ? todasActivas : asignadas)]
}

/**
 * Resuelve la sucursal activa.
 *
 * Orden de preferencia:
 *   1. La pedida por cookie, SI el usuario la tiene asignada.
 *   2. La marcada por defecto entre las suyas.
 *   3. La primera por código, para que el resultado sea estable entre
 *      peticiones (un orden no determinista haría que dos pestañas del mismo
 *      cajero emitieran con series distintas).
 *   4. `undefined` si no tiene ninguna: el servicio lo rechazará con un
 *      mensaje claro en vez de inventarse una.
 */
export function resolverSucursalActiva(
  asignadas: readonly BranchOption[],
  pedida?: string,
): string | undefined {
  if (asignadas.length === 0) return undefined

  if (pedida) {
    const valida = asignadas.find((b) => b.id === pedida)
    if (valida) return valida.id
    // Pidió una que no es suya: se ignora en silencio y se sigue con la
    // propia. No es un error del usuario — suele ser una cookie vieja tras
    // un cambio de asignación.
  }

  const porDefecto = asignadas.find((b) => b.isDefault)
  if (porDefecto) return porDefecto.id

  return [...asignadas].sort((a, b) => a.code.localeCompare(b.code))[0]!.id
}
