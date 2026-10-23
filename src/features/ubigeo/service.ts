import { BusinessError } from '@/lib/errors'
import { prisma } from '@/lib/prisma'

/**
 * Consultas al catálogo de ubigeo (global, de solo lectura).
 *
 * La tabla `ubigeos` NO tiene `tenantId`: es el mismo catálogo para todos. Por
 * eso se lee con el cliente base y no con `getTenantPrisma`. No expone datos de
 * ningún negocio.
 *
 * Mientras la tabla esté vacía (aún no se cargó el fichero oficial del INEI) las
 * pantallas caen a un campo de 6 dígitos y la validación se queda en el formato:
 * `distritoExiste` devuelve `null` («no puedo saberlo»), no `true`.
 */

export interface OpcionUbigeo { codigo: string; nombre: string }

export async function estadoCatalogo(): Promise<{ cargado: boolean; version: string | null }> {
  const primero = await prisma.ubigeo.findFirst({ where: { nivel: 1 }, select: { version: true } })
  return { cargado: primero !== null, version: primero?.version ?? null }
}

/** Departamentos (sin `padre`) o los hijos de un código. */
export async function listarHijos(padre?: string): Promise<OpcionUbigeo[]> {
  if (padre !== undefined && !/^\d{6}$/.test(padre)) return []
  const filas = await prisma.ubigeo.findMany({
    where: padre === undefined ? { nivel: 1 } : { padre },
    orderBy: { nombre: 'asc' },
    select: { codigo: true, nombre: true },
  })
  return filas
}

export interface UbicacionDescrita { departamento: string; provincia: string; distrito: string }

export async function describirUbigeo(codigo: string): Promise<UbicacionDescrita | null> {
  if (!/^\d{6}$/.test(codigo)) return null
  const filas = await prisma.ubigeo.findMany({
    where: { codigo: { in: [`${codigo.slice(0, 2)}0000`, `${codigo.slice(0, 4)}00`, codigo] } },
    select: { codigo: true, nombre: true, nivel: true },
  })
  const por = (n: number) => filas.find((f) => f.nivel === n)?.nombre
  const distrito = por(3)
  return distrito ? { departamento: por(1) ?? '', provincia: por(2) ?? '', distrito } : null
}

/**
 * ¿Existe ese distrito en el catálogo? `null` = el catálogo aún no está cargado,
 * no se puede afirmar ni negar (solo se valida el formato).
 */
export async function distritoExiste(codigo: string): Promise<boolean | null> {
  if (!/^\d{6}$/.test(codigo)) return false
  if (!(await estadoCatalogo()).cargado) return null
  const f = await prisma.ubigeo.findUnique({ where: { codigo }, select: { nivel: true } })
  return f?.nivel === 3
}

/** Rechaza un ubigeo que NO está en el catálogo. Con el catálogo sin cargar solo se valida el formato. */
export async function exigirDistritoValido(codigo: string, etiqueta = 'El ubigeo'): Promise<void> {
  const e = await distritoExiste(codigo)
  if (e === false) {
    throw new BusinessError('INVALID_DOCUMENT', `${etiqueta} ${codigo} no es un distrito del catálogo del INEI.`)
  }
}
