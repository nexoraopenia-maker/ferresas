import type { Permiso } from '@/lib/permisos'

/**
 * Quién puede VER los clientes (lista, ficha, estado de cuenta). Vive aparte, sin dependencias de servidor, porque lo importan el
 * servicio (que decide), el menú (que muestra u oculta el enlace) y las páginas: los tres tienen que decidir por la MISMA lista.
 *
 * Gestionar (crear, editar, dar de baja) es solo `clientes.gestionar`; el resto ve para poder cobrar o administrar el crédito.
 */
export const PERMISOS_VER_CLIENTES = ['clientes.gestionar', 'credito.cobrar', 'credito.limite', 'credito.castigar'] as const satisfies readonly Permiso[]
