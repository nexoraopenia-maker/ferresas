import { z } from 'zod'

/** Un texto opcional: vacío o solo espacios cuenta como «sin dato», no como una cadena vacía guardada. */
const opcional = (max: number) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().max(max).optional())

const id = z.string().trim().min(1).max(64)

const datosCliente = {
  name: z.string().trim().min(2, 'El nombre debe tener al menos 2 letras.').max(120),
  /** DNI (8) o RUC (11). Vacío = cliente sin documento (no podrá comprar a crédito). El tipo se deduce del largo. */
  docNumber: opcional(15),
  phone: opcional(30),
  email: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.email('Correo no válido.').max(120).optional()),
  address: opcional(200),
  notes: opcional(500),
}

export const crearClienteSchema = z.object(datosCliente)
export type CrearClienteInput = z.infer<typeof crearClienteSchema>

export const editarClienteSchema = z.object({ customerId: id, ...datosCliente })
export type EditarClienteInput = z.infer<typeof editarClienteSchema>

export const bajaClienteSchema = z.object({ customerId: id, motivo: z.string().trim().min(3, 'Explica el motivo.').max(200) })
export type BajaClienteInput = z.infer<typeof bajaClienteSchema>

export const reactivarClienteSchema = z.object({ customerId: id })
export type ReactivarClienteInput = z.infer<typeof reactivarClienteSchema>

export const FILTROS_CLIENTE = ['TODOS', 'CON_DEUDA', 'VENCIDOS', 'BLOQUEADOS', 'SIN_DOCUMENTO', 'DE_BAJA'] as const
export type FiltroCliente = (typeof FILTROS_CLIENTE)[number]

export const listarClientesSchema = z.object({
  q: opcional(80),
  filtro: z.enum(FILTROS_CLIENTE).default('TODOS'),
  cursor: id.optional(),
  limite: z.number().int().min(1).max(100).default(50),
})
export type ListarClientesInput = z.infer<typeof listarClientesSchema>

export const fichaClienteSchema = z.object({ customerId: id })
