'use server'

import { requireIdentidad } from '@/lib/session'
import { describirUbigeo, estadoCatalogo, listarHijos, type OpcionUbigeo, type UbicacionDescrita } from './service'

/**
 * Consultas del selector. Exigen sesión (no son un endpoint público) pero no
 * dependen del negocio: el catálogo es global.
 */

export async function estadoUbigeoAction(): Promise<{ cargado: boolean }> {
  await requireIdentidad()
  return { cargado: (await estadoCatalogo()).cargado }
}

export async function listarUbigeoAction(padre?: string): Promise<OpcionUbigeo[]> {
  await requireIdentidad()
  return listarHijos(padre)
}

export async function describirUbigeoAction(codigo: string): Promise<UbicacionDescrita | null> {
  await requireIdentidad()
  return describirUbigeo(codigo)
}
