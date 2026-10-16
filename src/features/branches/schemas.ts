import { z } from 'zod'
import { SERIES_NUMBER_MAX, SERIES_NUMBER_MIN } from './series'

const id = z.string().min(1).max(64)

/**
 * Código de establecimiento anexo ante SUNAT: cuatro dígitos.
 * "0000" es la casa matriz; los anexos van numerados por SUNAT al darlos de
 * alta en el RUC, así que se teclean, no se inventan.
 */
const establishmentCode = z
  .string()
  .trim()
  .regex(/^\d{4}$/, 'El código de establecimiento son cuatro dígitos, como 0001.')

/**
 * Ubigeo INEI: seis dígitos (departamento 2 + provincia 2 + distrito 2).
 * No se valida contra el catálogo real: eso exigiría embarcar las ~1870
 * entradas del INEI, y el dato no bloquea ninguna operación. Marcado en
 * docs/COMPLIANCE.md.
 */
const ubigeo = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'El ubigeo son seis dígitos, como 150101.')

const codigo = z
  .string()
  .trim()
  .toUpperCase()
  .min(2, 'El código es demasiado corto.')
  .max(20)
  .regex(/^[A-Z0-9-]+$/, 'El código admite solo letras, números y guiones.')

export const createBranchSchema = z.object({
  code: codigo,
  name: z.string().trim().min(2, 'Ponle un nombre a la sucursal.').max(120),
  establishmentCode,
  /**
   * Opcional a propósito: si no se manda, el servidor asigna el siguiente
   * libre. Dejarlo elegir al cliente sin validar permitiría pisar la serie
   * de otra sucursal, que es justo lo que el índice único impide.
   */
  seriesNumber: z.number().int().min(SERIES_NUMBER_MIN).max(SERIES_NUMBER_MAX).optional(),
  address: z.string().trim().max(300).optional(),
  ubigeo: ubigeo.optional(),
  phone: z.string().trim().max(40).optional(),
  email: z.string().trim().email('Correo no válido.').max(160).optional(),
  managerId: id.optional(),
  /** Crea también un almacén principal dentro de la sucursal. */
  crearAlmacen: z.boolean().default(true),
})

export type CreateBranchInput = z.infer<typeof createBranchSchema>

export const updateBranchSchema = z.object({
  branchId: id,
  name: z.string().trim().min(2).max(120).optional(),
  address: z.string().trim().max(300).optional(),
  ubigeo: ubigeo.optional(),
  phone: z.string().trim().max(40).optional(),
  email: z.string().trim().email().max(160).optional(),
  managerId: id.nullable().optional(),
  isActive: z.boolean().optional(),
  /*
   * `code`, `establishmentCode` y `seriesNumber` NO se pueden cambiar.
   * La serie va impresa en los comprobantes ya emitidos: cambiarla rompería
   * la correspondencia entre lo impreso y lo registrado. Para "cambiar de
   * serie" se da de baja la sucursal y se crea otra.
   */
})

export type UpdateBranchInput = z.infer<typeof updateBranchSchema>

export const deleteBranchSchema = z.object({
  branchId: id,
  reason: z.string().trim().min(5, 'Indica por qué se da de baja.').max(300),
})

export type DeleteBranchInput = z.infer<typeof deleteBranchSchema>

export const assignBranchesSchema = z.object({
  userId: id,
  /** Lista COMPLETA de sucursales del usuario: lo que no venga, se quita. */
  branchIds: z.array(id).max(999),
})

export type AssignBranchesInput = z.infer<typeof assignBranchesSchema>
