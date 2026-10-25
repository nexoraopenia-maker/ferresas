import { PERMISOS, type Permiso } from '@/lib/permisos'

/**
 * Reglas del PIN de cajero, PURAS (sin base de datos, sin cookies).
 *
 * El PIN identifica a quien está operando en un dispositivo cuya sesión ya
 * está abierta. No es un segundo inicio de sesión ni una forma de «subir de
 * nivel»: el contexto resultante nunca tiene más permisos que la sesión del
 * dispositivo NI más que el propio operador.
 */

/** Fallos seguidos que bloquean el PIN. */
export const MAX_INTENTOS_PIN = 5

/**
 * Lo que un operador por PIN NO puede hacer NUNCA, aunque su rol y el de la
 * sesión lo permitan: gestionar personas, sucursales, plan y datos fiscales.
 * Un PIN de 4 cifras no puede abrir la puerta de la administración.
 */
export const PERMISOS_FUERA_DEL_PIN: readonly Permiso[] = [
  'usuarios.gestionar',
  'sucursales.gestionar',
  'plan.gestionar',
  'config.fiscal',
  'comprobantes.estado_manual',
  // Subir la línea de un cliente o dar de baja una deuda son decisiones de administración: un PIN de 4 cifras no las abre.
  'credito.limite',
  'credito.castigar',
]

export type ErrorPin = 'FORMATO' | 'FACIL'

/** 4 a 6 cifras, y nada que se adivine en un intento: 0000, 1234, 4321, 1111… */
export function validarFormatoPin(pin: string): { valido: true } | { valido: false; motivo: ErrorPin; mensaje: string } {
  if (!/^\d{4,6}$/.test(pin)) return { valido: false, motivo: 'FORMATO', mensaje: 'El PIN son de 4 a 6 números.' }
  if (/^(\d)\1+$/.test(pin)) return { valido: false, motivo: 'FACIL', mensaje: 'Ese PIN es demasiado fácil: no repitas el mismo número.' }
  const d = [...pin].map(Number)
  const sube = d.every((n, i) => i === 0 || n === d[i - 1]! + 1)
  const baja = d.every((n, i) => i === 0 || n === d[i - 1]! - 1)
  if (sube || baja) return { valido: false, motivo: 'FACIL', mensaje: 'Ese PIN es demasiado fácil: no uses una secuencia.' }
  return { valido: true }
}

/**
 * Permisos a QUITAR del operador: todo lo que la sesión del dispositivo no
 * tiene, más lo vedado al PIN. Aplicado sobre los permisos del operador deja la
 * INTERSECCIÓN de ambos, menos lo vedado.
 */
export function permisosDenegadosAlOperador(sesion: ReadonlySet<Permiso>): Permiso[] {
  return PERMISOS.filter((p) => !sesion.has(p) || PERMISOS_FUERA_DEL_PIN.includes(p))
}
