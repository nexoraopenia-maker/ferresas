import { z } from 'zod'

/**
 * Registro de un nuevo tenant (§5.2).
 *
 * Este es el ÚNICO formulario del SaaS que acepta datos de alguien sin
 * sesión. Todo lo que entre aquí hay que tratarlo como hostil.
 */

export const registerSchema = z.object({
  businessName: z
    .string()
    .trim()
    .min(3, 'El nombre de la ferretería es muy corto.')
    .max(120, 'El nombre es demasiado largo.'),
  ownerName: z
    .string()
    .trim()
    .min(2, 'Escribe tu nombre.')
    .max(120, 'El nombre es demasiado largo.'),
  email: z.email('Correo inválido.').max(200).toLowerCase().trim(),
  password: z
    .string()
    .min(8, 'Usa al menos 8 caracteres.')
    .max(200, 'La contraseña es demasiado larga.')
    // Sin exigir símbolos ni mayúsculas: esas reglas empujan a "Password1!"
    // y a apuntarla en un papel junto a la caja. La longitud es lo que
    // importa de verdad.
    .refine((p) => p.trim().length >= 8, 'La contraseña no puede ser solo espacios.'),
  /**
   * Código del plan. Se valida contra la tabla Plan en el servidor: jamás se
   * confía en precios ni límites que vengan del cliente.
   */
  planCode: z.string().trim().min(1).max(40),
  phone: z.string().trim().max(30).optional(),
  taxId: z.string().trim().max(20).optional(),
})

export type RegisterInput = z.infer<typeof registerSchema>

/**
 * Convierte el nombre del negocio en un slug usable como subdominio.
 * Se hace en el servidor a partir del nombre validado, nunca se acepta del
 * cliente: el slug es parte de la identidad del tenant.
 */
export function slugify(name: string): string {
  const base = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // quita tildes: "Ferretería" -> "Ferreteria"
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)

  return base || 'ferreteria'
}

/** Slugs que no pueden pertenecer a un tenant porque son rutas del sistema. */
export const SLUGS_RESERVADOS = new Set([
  'api', 'admin', 'superadmin', 'login', 'registro', 'app', 'www',
  'facturacion', 'inventario', 'cuenta', 'soporte', 'legal', 'blog',
])
