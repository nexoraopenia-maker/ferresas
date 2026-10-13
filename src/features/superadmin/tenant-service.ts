import { randomInt } from 'node:crypto'
import { registerTenant, type RegisterActor } from '@/features/onboarding/service'
import { registerSchema } from '@/features/onboarding/schemas'
import type { CreateTenantBySuperAdminInput } from '@/features/onboarding/schemas'

/**
 * Alta de clientes desde la torre de control (§5.3).
 *
 * Se apoya en `registerTenant`, el MISMO código del autoservicio, en vez de
 * duplicar la transacción. Si hubiera dos caminos para crear un tenant,
 * tarde o temprano uno de los dos se olvidaría de crear el almacén por
 * defecto, o la suscripción, y el bug aparecería solo en las cuentas dadas de
 * alta por un camino. Un solo camino, ya cubierto por 30 pruebas.
 */

export interface CreateTenantResult {
  tenantId: string
  slug: string
  userId: string
  planName: string
  trialEndsAt: Date
  ownerEmail: string
  /**
   * Presente SOLO si la generó el sistema. Se devuelve una vez y no se
   * guarda en ningún sitio en claro: en la base vive su hash bcrypt.
   */
  generatedPassword?: string
}

/**
 * Contraseña temporal legible por teléfono.
 *
 * Sin caracteres ambiguos (l/1/I, O/0) porque el flujo real es que el Super
 * Admin se la dicte al ferretero por WhatsApp o llamada, y "¿era ele o uno?"
 * acaba en un ticket de soporte.
 *
 * Usa `randomInt` de node:crypto, no `Math.random()`: esta cadena es la única
 * barrera de una cuenta recién creada, y `Math.random()` es predecible.
 */
const ALFABETO = 'abcdefghjkmnpqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ23456789'

export function generateTempPassword(longitud = 16): string {
  let salida = ''
  for (let i = 0; i < longitud; i++) {
    salida += ALFABETO[randomInt(ALFABETO.length)]
  }
  // Se parte en grupos de 4: dictarla y teclearla deja de ser un suplicio.
  return salida.match(/.{1,4}/g)!.join('-')
}

export async function createTenantBySuperAdmin(
  input: CreateTenantBySuperAdminInput,
  actor: RegisterActor,
  now: Date = new Date(),
): Promise<CreateTenantResult> {
  const generada = input.password ? undefined : generateTempPassword()
  const password = input.password ?? generada!

  // Se vuelve a validar con el esquema del autoservicio ya con la contraseña
  // puesta: así la contraseña generada pasa por las mismas reglas que una
  // escrita a mano, en vez de confiar en que el generador las cumple.
  const completo = registerSchema.parse({ ...input, password })

  const r = await registerTenant(completo, now, actor)

  return {
    tenantId: r.tenantId,
    slug: r.slug,
    userId: r.userId,
    planName: r.planName,
    trialEndsAt: r.trialEndsAt,
    ownerEmail: completo.email,
    generatedPassword: generada,
  }
}
