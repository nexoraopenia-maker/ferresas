/**
 * Redondeo monetario a céntimos.
 *
 * ─── EL PROBLEMA QUE RESUELVE ────────────────────────────────────────────
 *
 * El idiom habitual, `Math.round(n * 100) / 100`, falla justo en el caso que
 * importa: 0.145 * 100 da 14.499999999999998 en coma flotante binaria, así
 * que redondea a 14 en lugar de a 15. Lo mismo con 1.005, 2.675 y cualquier
 * valor cuyo tercer decimal sea un 5 exacto.
 *
 * El `toFixed(4)` intermedio normaliza el error de representación ANTES de
 * redondear: lo que llega a `Math.round` es el 14.5 que el humano escribió,
 * no el 14.4999… que el binario puede expresar. Es redondeo "la mitad hacia
 * arriba", que es la convención con la que se emiten comprobantes en Perú.
 *
 * El límite de Decimal(14,2) deja holgura de sobra para que `toFixed(4)` no
 * pierda precisión por el otro extremo.
 */

/** Céntimos enteros de un importe. Pierde el signo: redondea el valor absoluto. */
export function aCentimos(monto: number): number {
  return Math.round(Number((Math.abs(monto) * 100).toFixed(4)))
}

/** Importe cuantizado a 2 decimales, conservando el signo. */
export function redondearCentimos(monto: number): number {
  return (monto < 0 ? -1 : 1) * aCentimos(monto) / 100
}

/**
 * ¿Tiene `n` como máximo `decimales` decimales?
 *
 * NO se puede comprobar con `Math.round(n * 100) === n * 100`: en coma
 * flotante `1.1 * 100` es `110.00000000000001`, así que 1,10; 2,30; 4,35;
 * 8,20 o 19,99 —importes perfectamente normales— se rechazaban como «más de 2
 * decimales». Se compara contra el propio número normalizado: `toFixed`
 * produce la representación decimal más cercana, que es lo que el humano
 * escribió, y `1.005` (que el binario guarda como 1.00499…) sigue siendo
 * rechazado con razón.
 */
export function tieneMaxDecimales(n: number, decimales: number): boolean {
  return Number.isFinite(n) && Number(n.toFixed(decimales)) === n
}
