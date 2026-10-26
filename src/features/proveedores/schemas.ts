import { z } from 'zod'

/** Un texto opcional: vacío o solo espacios cuenta como «sin dato», no como una cadena vacía guardada. */
const opcional = (max: number) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().max(max).optional())

const id = z.string().trim().min(1).max(64)

const datosProveedor = {
  name: z.string().trim().min(2, 'El nombre debe tener al menos 2 letras.').max(120),
  /** RUC de 11 dígitos. Vacío = proveedor sin RUC (informal): no se le podrá registrar una factura por RUC. */
  taxId: opcional(11),
  contact: opcional(120),
  phone: opcional(30),
  email: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.email('Correo no válido.').max(120).optional()),
  address: opcional(200),
  notes: opcional(500),
  /** Días de plazo con que este proveedor suele vender a crédito (0 = sin plazo propio). */
  paymentTermDays: z.number().int('El plazo es un número entero de días.').min(0).max(365, 'El plazo máximo es de 365 días.').default(0),
}

export const crearProveedorSchema = z.object(datosProveedor)
export type CrearProveedorInput = z.infer<typeof crearProveedorSchema>

export const editarProveedorSchema = z.object({ supplierId: id, ...datosProveedor })
export type EditarProveedorInput = z.infer<typeof editarProveedorSchema>

export const bajaProveedorSchema = z.object({ supplierId: id, motivo: z.string().trim().min(3, 'Explica el motivo.').max(200) })
export type BajaProveedorInput = z.infer<typeof bajaProveedorSchema>

export const reactivarProveedorSchema = z.object({ supplierId: id })
export type ReactivarProveedorInput = z.infer<typeof reactivarProveedorSchema>

export const FILTROS_PROVEEDOR = ['TODOS', 'CON_DEUDA', 'DE_BAJA'] as const
export type FiltroProveedor = (typeof FILTROS_PROVEEDOR)[number]

export const listarProveedoresSchema = z.object({
  q: opcional(80),
  filtro: z.enum(FILTROS_PROVEEDOR).default('TODOS'),
  cursor: id.optional(),
  limite: z.number().int().min(1).max(100).default(50),
})
export type ListarProveedoresInput = z.infer<typeof listarProveedoresSchema>

export const fichaProveedorSchema = z.object({ supplierId: id })
