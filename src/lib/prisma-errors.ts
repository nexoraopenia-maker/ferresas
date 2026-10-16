import { Prisma } from '@/generated/prisma/client'

export const P2002_UNIQUE = 'P2002'

/**
 * Qué campos colisionaron en una violación de índice único.
 *
 * ─── POR QUÉ NO BASTA `e.meta.target` ────────────────────────────────────
 *
 * Es la propiedad que documenta Prisma y la que usa medio internet, pero con
 * el DRIVER ADAPTER (`@prisma/adapter-pg`, obligatorio en Prisma 7) NO SE
 * RELLENA. El detalle llega en otra forma:
 *
 *   meta.driverAdapterError.cause.constraint.fields = ['"tenantId"', '"code"']
 *
 * —con las comillas dobles incluidas, tal como las devuelve Postgres.
 *
 * El efecto de leer solo `target` es silencioso y por eso peligroso: la
 * comprobación `campos.includes('barcode')` nunca acierta, así que el usuario
 * recibe siempre el mensaje del último `else` y se le pide corregir un campo
 * que estaba bien. No falla ninguna prueba que solo mire el código de error.
 *
 * Esta función lee las TRES fuentes y normaliza, de modo que da igual qué
 * motor haya debajo.
 */
export function camposDeColision(e: unknown): string {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError)) return ''

  const meta = e.meta as
    | {
        target?: string[] | string
        driverAdapterError?: {
          cause?: {
            constraint?: { fields?: string[]; index?: string } | string
          }
        }
      }
    | undefined

  const partes: string[] = []

  // 1. Forma clásica del motor de consultas.
  if (Array.isArray(meta?.target)) partes.push(...meta.target)
  else if (typeof meta?.target === 'string') partes.push(meta.target)

  // 2. Forma del driver adapter de pg.
  const constraint = meta?.driverAdapterError?.cause?.constraint
  if (typeof constraint === 'string') {
    partes.push(constraint)
  } else if (constraint) {
    if (Array.isArray(constraint.fields)) partes.push(...constraint.fields)
    // 3. El NOMBRE del índice, que suele incluir los campos
    //    ("branches_tenantId_code_key") y sirve de red de seguridad.
    if (constraint.index) partes.push(constraint.index)
  }

  // Las comillas dobles de Postgres romperían cualquier `includes`.
  return partes.join(',').replace(/"/g, '')
}

/** `true` si el error es una violación de índice único. */
export function esColisionUnica(e: unknown): boolean {
  return (
    e instanceof Prisma.PrismaClientKnownRequestError && e.code === P2002_UNIQUE
  )
}
