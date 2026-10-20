import { z } from 'zod'

const id = z.string().min(1).max(64)

/** Se valida como texto y se acota al enum de Prisma en el servicio. */
export const rolSchema = z.enum(['ADMIN', 'VENDEDOR', 'CAJERO', 'ALMACENERO', 'CONTADOR'])

const rolesExtra = z
  .array(rolSchema)
  .max(4)
  .default([])

export const invitarSchema = z
  .object({
    // Se limpia ANTES de validar: un correo pegado con un espacio al final es válido.
    email: z.string().trim().toLowerCase().pipe(z.email('Correo inválido.').max(200)),
    role: rolSchema,
    extraRoles: rolesExtra,
    /** Sucursales a las que quedará asignado. */
    branchIds: z.array(id).max(50).default([]),
  })
  .transform((v) => ({
    ...v,
    // Un rol repetido, o el principal también como extra, no suma nada.
    extraRoles: [...new Set(v.extraRoles)].filter((r) => r !== v.role),
    branchIds: [...new Set(v.branchIds)],
  }))
export type InvitarInput = z.infer<typeof invitarSchema>

export const revocarSchema = z.object({ invitationId: id })

export const cambiarRolesSchema = z
  .object({ userId: id, role: rolSchema, extraRoles: rolesExtra })
  .transform((v) => ({
    ...v,
    extraRoles: [...new Set(v.extraRoles)].filter((r) => r !== v.role),
  }))
export type CambiarRolesInput = z.infer<typeof cambiarRolesSchema>

export const cambiarEstadoSchema = z.object({ userId: id, activo: z.boolean() })
export type CambiarEstadoInput = z.infer<typeof cambiarEstadoSchema>

/** La misma regla que el registro y la aceptación de invitaciones. */
export const passwordSchema = z
  .string()
  .min(8, 'Usa al menos 8 caracteres.')
  .max(200, 'La contraseña es demasiado larga.')
  .refine((p) => p.trim().length >= 8, 'La contraseña no puede ser solo espacios.')

export const crearDirectoSchema = z
  .object({
    name: z.string().trim().min(2, 'Escribe el nombre.').max(120),
    email: z.string().trim().toLowerCase().pipe(z.email('Correo inválido.').max(200)),
    password: passwordSchema,
    role: rolSchema,
    extraRoles: rolesExtra,
    branchIds: z.array(id).max(50).default([]),
  })
  .transform((v) => ({
    ...v,
    extraRoles: [...new Set(v.extraRoles)].filter((r) => r !== v.role),
    branchIds: [...new Set(v.branchIds)],
  }))
export type CrearDirectoInput = z.infer<typeof crearDirectoSchema>

export const cambiarPasswordSchema = z.object({ userId: id, password: passwordSchema })
export type CambiarPasswordInput = z.infer<typeof cambiarPasswordSchema>

export const aceptarSchema = z.object({
  token: z.string().min(20).max(200),
  name: z.string().trim().min(2, 'Escribe tu nombre.').max(120),
  password: z
    .string()
    .min(8, 'Usa al menos 8 caracteres.')
    .max(200, 'La contraseña es demasiado larga.')
    .refine((p) => p.trim().length >= 8, 'La contraseña no puede ser solo espacios.'),
})
export type AceptarInput = z.infer<typeof aceptarSchema>
