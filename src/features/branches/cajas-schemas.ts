import { z } from 'zod'

const id = z.string().trim().min(1).max(64)
const nombre = z.string().trim().min(2, 'El nombre necesita al menos 2 letras.').max(30, 'El nombre pasa de 30 caracteres.')

/** Cajas vivas por sucursal: el tope aprobado por el dueño (F6.8). */
export const MAX_CAJAS_POR_SUCURSAL = 5
/** El nombre de la caja que se crea sola en cada sucursal. */
export const NOMBRE_CAJA_PRINCIPAL = 'Caja principal'

export const crearCajaSchema = z.object({ branchId: id, name: nombre })
export type CrearCajaInput = z.infer<typeof crearCajaSchema>

export const renombrarCajaSchema = z.object({ registerId: id, name: nombre })
export type RenombrarCajaInput = z.infer<typeof renombrarCajaSchema>

export const darDeBajaCajaSchema = z.object({ registerId: id })
export type DarDeBajaCajaInput = z.infer<typeof darDeBajaCajaSchema>
