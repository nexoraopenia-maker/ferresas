import { huella, normalizarHuella } from './huella-bd'

/**
 * Comprobaciones puras del diagnóstico de la base de datos que usa la app EN EJECUCIÓN (`/api/diagnostics`).
 * Sin secretos: solo «host/nombre de base» y booleanos.
 */

export interface FilaMigracion { migration_name: string; ok: boolean; rolled_back: boolean }

/**
 * Una migración está APLICADA si alguna de sus filas terminó bien. Prisma deja una fila nueva por cada intento:
 * tras `migrate resolve --rolled-back` y un nuevo `migrate deploy` quedan DOS filas con el mismo nombre (la
 * revertida y la buena). Contar la revertida como «fallida» da una falsa alarma permanente (pasó con
 * `20261020120000_cost_pending`). Fallida = tiene filas y NINGUNA terminó bien. `reintentadas` = hubo un fallo
 * previo, pero ya está aplicada (informativo, no es un problema).
 */
export function clasificarMigraciones(filas: FilaMigracion[]): { aplicadas: string[]; fallidas: string[]; reintentadas: string[] } {
  const porNombre = new Map<string, FilaMigracion[]>()
  for (const f of filas) porNombre.set(f.migration_name, [...(porNombre.get(f.migration_name) ?? []), f])
  const aplicadas: string[] = [], fallidas: string[] = [], reintentadas: string[] = []
  for (const [nombre, fs] of porNombre) {
    if (fs.some((f) => f.ok)) {
      aplicadas.push(nombre)
      if (fs.some((f) => !f.ok)) reintentadas.push(nombre)
    } else {
      fallidas.push(nombre)
    }
  }
  return { aplicadas, fallidas, reintentadas }
}

export interface DiagnosticoHuella {
  /** Base a la que está conectada la app (DATABASE_URL), como «host/base». */
  conectadaA: string | null
  /** Lo que declara `PROD_DB_FINGERPRINT`. */
  esperada: string | null
  /** null si no se puede comparar (falta uno de los dos). */
  coincide: boolean | null
  problemas: string[]
}

/**
 * ¿Está la app conectada a la base que dice ser la de producción?
 *
 * Existe porque una huella mal puesta es invisible: la guardia protege contra escribir donde no se debe, pero
 * nada avisaba de que la variable (o `.env`) apuntaba a una base que NO es la que usa Vercel. En producción, la
 * huella declarada debe coincidir con la base conectada; en cualquier otro entorno, NO debe coincidir
 * (una vista previa conectada a producción es un accidente esperando a pasar).
 */
export function diagnosticarHuella(env: Record<string, string | undefined>): DiagnosticoHuella {
  const conectadaA = huella(env.DATABASE_URL)
  const directa = env.DIRECT_URL ? huella(env.DIRECT_URL) : null
  const esperada = normalizarHuella(env.PROD_DB_FINGERPRINT)
  const enProduccion = env.VERCEL_ENV === 'production'
  const problemas: string[] = []

  if (conectadaA && directa && conectadaA !== directa) {
    problemas.push(`DATABASE_URL (${conectadaA}) y DIRECT_URL (${directa}) apuntan a bases distintas: las migraciones y la app no verían lo mismo.`)
  }
  if (env.PROD_DB_FINGERPRINT && !esperada) {
    problemas.push('PROD_DB_FINGERPRINT no tiene la forma «host/nombre_de_base» (sin usuario, clave ni parámetros).')
  }
  if (enProduccion) {
    if (!esperada) {
      problemas.push('PROD_DB_FINGERPRINT no está definida en Producción: la guardia del build negará `prisma migrate deploy` y no se podrá comprobar la base.')
    } else if (conectadaA && conectadaA !== esperada) {
      problemas.push(`La base conectada (${conectadaA}) NO coincide con PROD_DB_FINGERPRINT (${esperada}): o la variable o DATABASE_URL apuntan a la base equivocada.`)
    }
  } else if (esperada && conectadaA === esperada) {
    problemas.push(`Este entorno (${env.VERCEL_ENV ?? 'local'}) está conectado a la base de PRODUCCIÓN (${conectadaA}).`)
  }

  return { conectadaA, esperada, coincide: esperada && conectadaA ? conectadaA === esperada : null, problemas }
}
