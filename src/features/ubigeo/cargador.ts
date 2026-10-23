import type { TotalesDeclarados } from './validar'

/** Valor que sigue a `--nombre`, o undefined. */
export function opcion(args: readonly string[], nombre: string): string | undefined {
  const i = args.indexOf(nombre)
  const v = i >= 0 ? args[i + 1] : undefined
  return v && !v.startsWith('--') ? v : undefined
}

/** Los totales declarados por la fuente. Sin ellos NO se carga: no hay contra qué validar. */
export function leerTotalesDeclarados(args: readonly string[]): TotalesDeclarados | string {
  const faltan: string[] = []
  const n = (nombre: string) => {
    const t = opcion(args, nombre)
    if (t === undefined) { faltan.push(nombre); return NaN }
    const v = Number(t)
    if (!Number.isInteger(v) || v <= 0) { faltan.push(`${nombre} (no es un entero positivo: "${t}")`); return NaN }
    return v
  }
  const t = { departamentos: n('--departamentos-fuente'), provincias: n('--provincias-fuente'), distritos: n('--distritos-fuente') }
  return faltan.length > 0
    ? `Faltan los totales que declara la fuente oficial: ${faltan.join(', ')}.\n  Cópialos de la página o del documento del INEI de donde descargaste el fichero.`
    : t
}

