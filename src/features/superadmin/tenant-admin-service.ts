import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/prisma'
import { BusinessError } from '@/lib/errors'
import { generateTempPassword } from './tenant-service'
import type {
  ResetOwnerPasswordInput,
  UpdateTenantProfileInput,
} from './schemas'

/**
 * Gestión de cuentas de cliente desde la torre de control (§5.3).
 *
 * ⚠️ Cliente base a propósito: estas operaciones cruzan tenants por
 * definición. Viven detrás de `requireSuperAdmin()` y cada una audita con
 * motivo obligatorio.
 */

interface Actor {
  id: string
  email: string
}

export interface ResetResult {
  userEmail: string
  /** Se devuelve UNA vez; en la base solo queda su hash. */
  temporaryPassword: string
}

/**
 * Resetea la contraseña de un usuario de una ferretería.
 *
 * ─── LA GUARDA QUE IMPORTA ───────────────────────────────────────────────
 *
 * Se rechaza si el objetivo es SUPERADMIN. Sin esa comprobación, un
 * superadmin podría resetear la contraseña de OTRO superadmin y quedarse con
 * su cuenta — y como el Super Admin ve todos los tenants, eso es la
 * escalada de privilegios más grave que admite el sistema. Para la propia
 * cuenta existe el modal de "cambiar mi contraseña", que sí exige la actual.
 *
 * Fija `passwordChangedAt`, así que las sesiones abiertas de ese usuario
 * quedan revocadas: si se resetea por sospecha de acceso indebido, dejarlas
 * vivas anularía el sentido.
 */
export async function resetOwnerPassword(
  input: ResetOwnerPasswordInput,
  actor: Actor,
  now: Date = new Date(),
): Promise<ResetResult> {
  const tenant = await prisma.tenant.findFirst({
    where: { id: input.tenantId, deletedAt: null },
    select: { id: true, name: true },
  })
  if (!tenant) throw new BusinessError('TENANT_MISMATCH', 'Cuenta no encontrada.')

  const objetivo = input.userId
    ? await prisma.user.findFirst({
        where: { id: input.userId, tenantId: tenant.id, deletedAt: null },
        select: { id: true, email: true, role: true },
      })
    : await prisma.user.findFirst({
        where: { tenantId: tenant.id, role: 'OWNER', isActive: true, deletedAt: null },
        select: { id: true, email: true, role: true },
        orderBy: { createdAt: 'asc' },
      })

  if (!objetivo) {
    throw new BusinessError(
      'TENANT_MISMATCH',
      'Esa ferretería no tiene un usuario dueño activo.',
    )
  }

  if (objetivo.role === 'SUPERADMIN') {
    throw new BusinessError(
      'FORBIDDEN_ROLE',
      'No se puede resetear la contraseña de otro Super Admin desde aquí.',
    )
  }

  // Tecleada por soporte o, si no, al azar. En ambos casos solo se guarda el hash (bcrypt, coste 12).
  const temporaryPassword = input.password ?? generateTempPassword()
  const passwordHash = await bcrypt.hash(temporaryPassword, 12)

  await prisma.$transaction([
    prisma.user.update({
      where: { id: objetivo.id },
      data: { passwordHash, passwordChangedAt: now, isActive: true },
    }),
    prisma.auditLog.create({
      data: {
        tenantId: tenant.id,
        actorId: actor.id,
        actorRole: 'SUPERADMIN',
        actorEmail: actor.email,
        action: 'tenant.password.reset',
        entityType: 'User',
        entityId: objetivo.id,
        reason: input.reason,
        // NUNCA se registra la contraseña ni su hash.
        after: { usuario: objetivo.email, sesionesRevocadas: true },
      },
    }),
  ])

  return { userEmail: objetivo.email, temporaryPassword }
}

/**
 * Edita los datos fiscales y de contacto de una ferretería.
 *
 * Solo se tocan los campos presentes en la entrada: un `undefined` significa
 * "no cambiar", mientras que una cadena vacía significa "borrar el dato".
 * Sin esa distinción, editar solo el teléfono borraría el RUC.
 */
export async function updateTenantProfile(
  input: UpdateTenantProfileInput,
  actor: Actor,
): Promise<{ tenantId: string; cambios: string[] }> {
  const antes = await prisma.tenant.findFirst({
    where: { id: input.tenantId, deletedAt: null },
    select: {
      id: true, name: true, legalName: true,
      taxId: true, phone: true, email: true, address: true,
    },
  })
  if (!antes) throw new BusinessError('TENANT_MISMATCH', 'Cuenta no encontrada.')

  const data: Record<string, string | null> = {}
  const cambios: string[] = []

  const campos = ['name', 'legalName', 'taxId', 'phone', 'email', 'address'] as const
  for (const campo of campos) {
    const valor = input[campo]
    if (valor === undefined) continue

    // Cadena vacía = borrar. `name` es obligatorio, así que no se vacía.
    const nuevo = valor === '' ? (campo === 'name' ? null : null) : valor
    if (campo === 'name' && !valor) continue

    if (antes[campo] !== nuevo) {
      data[campo] = nuevo
      cambios.push(campo)
    }
  }

  if (cambios.length === 0) {
    throw new BusinessError('DUPLICATE_CODE', 'No hay ningún cambio que guardar.')
  }

  try {
    await prisma.$transaction([
      prisma.tenant.update({ where: { id: antes.id }, data }),
      prisma.auditLog.create({
        data: {
          tenantId: antes.id,
          actorId: actor.id,
          actorRole: 'SUPERADMIN',
          actorEmail: actor.email,
          action: 'tenant.profile.update',
          entityType: 'Tenant',
          entityId: antes.id,
          reason: input.reason,
          before: Object.fromEntries(cambios.map((c) => [c, antes[c as (typeof campos)[number]]])),
          after: data,
        },
      }),
    ])
  } catch (e) {
    // `taxId` es único por tenant: dos ferreterías no pueden compartir RUC.
    if (
      e instanceof Error &&
      'code' in e &&
      (e as { code?: string }).code === 'P2002'
    ) {
      throw new BusinessError('DUPLICATE_CODE', 'Ese RUC ya está registrado en otra cuenta.')
    }
    throw e
  }

  return { tenantId: antes.id, cambios }
}


/**
 * BAJA DEFINITIVA de una ferretería (soft delete, NO borrado físico).
 *
 * ─── POR QUÉ NO SE BORRAN LAS FILAS ──────────────────────────────────────
 *
 * Los comprobantes electrónicos, sus XML firmados y los CDR de SUNAT deben conservarse (mínimo 5 años ⚠️ docs/SUNAT-SUPUESTOS.md #12) y la base tampoco deja borrar una venta
 * con comprobante (`TaxDocument.sale` es Restrict): un borrado en cascada fallaría o, peor, destruiría la prueba ante SUNAT. Por eso «dar de baja» deja la cuenta INERTE y
 * permanente: sin acceso, sin envíos, sin cobros, fuera de todos los listados, con sus datos intactos.
 *
 * Qué hace, en UNA transacción:
 *  · marca `deletedAt` y `isActive = false` (con el motivo en `suspendedReason`): `computeAccessLevel` la corta y los listados/workers ya filtran `deletedAt`;
 *  · desactiva a TODOS sus usuarios (nadie puede iniciar sesión, y las sesiones abiertas dejan de valer);
 *  · cancela su suscripción local (`CANCELED`); si el cobro vive en una pasarela hay que cancelarlo AHÍ aparte (esto no habla con la pasarela);
 *  · cierra las sesiones de soporte abiertas;
 *  · BORRA sus credenciales de SUNAT (certificado y clave SOL cifrados): son secretos de un negocio que ya no existe;
 *  · audita con el motivo, quién la dio de baja y qué se cerró.
 *
 * Salvaguardas: motivo ≥ 10 caracteres; el SuperAdmin debe ESCRIBIR el nombre exacto de la ferretería (se comprueba aquí, en el servidor, no solo en la pantalla);
 * no se da de baja un negocio con comprobantes o bajas todavía por enviar a SUNAT (quedarían varados sin que nadie los envíe) ni uno ya dado de baja. No se puede
 * deshacer desde el panel; el RUC y el subdominio quedan reservados por esos datos.
 */
export interface BajaDefinitivaInput { tenantId: string; reason: string; confirmacion: string }
export interface BajaDefinitivaResultado { usuariosDesactivados: number; suscripcionCancelada: boolean; credencialesSunatBorradas: boolean }

export async function darDeBajaDefinitiva(
  input: BajaDefinitivaInput, actor: Actor, now: Date = new Date(),
): Promise<BajaDefinitivaResultado> {
  const tenant = await prisma.tenant.findFirst({
    where: { id: input.tenantId, deletedAt: null },
    select: { id: true, name: true, isActive: true, taxId: true, sunatCredential: { select: { id: true } } },
  })
  if (!tenant) throw new BusinessError('TENANT_MISMATCH', 'Cuenta no encontrada o ya dada de baja.')
  if (input.reason.trim().length < 10) throw new BusinessError('INVALID_DOCUMENT', 'Explica el motivo con al menos 10 caracteres.')
  // Confirmación fuerte: el nombre EXACTO (sin distinguir mayúsculas ni espacios de los bordes). No basta con tener la pantalla abierta.
  if (input.confirmacion.trim().toLowerCase() !== tenant.name.trim().toLowerCase()) {
    throw new BusinessError('INVALID_DOCUMENT', 'El nombre escrito no coincide con el de la ferretería. No se dio de baja nada.')
  }

  const [docs, bajas] = await Promise.all([
    prisma.taxDocument.count({ where: { tenantId: tenant.id, isTrial: false, status: { in: ['PENDIENTE', 'ENVIADO'] } } }),
    prisma.taxVoid.count({ where: { tenantId: tenant.id, status: { in: ['PENDIENTE', 'ENVIADA'] } } }),
  ])
  if (docs + bajas > 0) {
    throw new BusinessError(
      'INVALID_DOCUMENT',
      `No se puede dar de baja: quedan ${docs} comprobante(s) y ${bajas} baja(s) por resolver ante SUNAT. Envíalos o resuélvelos antes, o quedarían varados.`,
      { comprobantes: docs, bajas },
    )
  }

  return prisma.$transaction(async (tx) => {
    // Atómico sobre el estado previo: dos SuperAdmin a la vez no la dan de baja ni la auditan dos veces.
    const r = await tx.tenant.updateMany({
      where: { id: tenant.id, deletedAt: null },
      data: { deletedAt: now, isActive: false, suspendedAt: now, suspendedReason: `BAJA DEFINITIVA: ${input.reason.trim()}`.slice(0, 500) },
    })
    if (r.count !== 1) throw new BusinessError('TENANT_MISMATCH', 'La cuenta ya fue dada de baja.')
    const usuarios = await tx.user.updateMany({ where: { tenantId: tenant.id, isActive: true }, data: { isActive: false } })
    const sub = await tx.subscription.updateMany({ where: { tenantId: tenant.id, status: { not: 'CANCELED' } }, data: { status: 'CANCELED', canceledAt: now } })
    await tx.impersonationSession.updateMany({ where: { tenantId: tenant.id, endedAt: null }, data: { endedAt: now } })
    const cred = await tx.sunatCredential.deleteMany({ where: { tenantId: tenant.id } })
    await tx.auditLog.create({
      data: {
        tenantId: tenant.id, actorId: actor.id, actorRole: 'SUPERADMIN', actorEmail: actor.email,
        action: 'tenant.baja_definitiva', entityType: 'Tenant', entityId: tenant.id, reason: input.reason.trim(),
        before: { isActive: tenant.isActive, nombre: tenant.name, ruc: tenant.taxId },
        after: { deleted: true, usuariosDesactivados: usuarios.count, suscripcionCancelada: sub.count > 0, credencialesSunatBorradas: cred.count > 0 },
      },
    })
    return { usuariosDesactivados: usuarios.count, suscripcionCancelada: sub.count > 0, credencialesSunatBorradas: cred.count > 0 }
  })
}
