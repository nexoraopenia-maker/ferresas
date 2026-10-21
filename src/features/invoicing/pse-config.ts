import { BusinessError } from '@/lib/errors'
import { ClaveMaestraAusente, CifradoInvalido, cifrar, descifrar, hayClaveMaestra } from '@/lib/cifrado'
import { exigir } from '@/lib/puede'
import type { TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { obtenerProveedor } from './providers'
import type { CredencialesProveedor, ProveedorFacturacion } from './providers/types'
import { UrlNoPermitida, validarUrlPse } from './url-segura'

/**
 * Credenciales del PSE de cada negocio.
 *
 * La URL va en claro (no es secreta); el TOKEN va cifrado con AES-256-GCM,
 * atado al `tenantId`, y no vuelve a salir de aquí hacia el navegador: la
 * pantalla solo sabe si «está configurado» y a qué proveedor (el host).
 * Configurarlo es del dueño (`config.fiscal`).
 */

export interface EstadoPse {
  configurado: boolean
  /** Solo el host (p. ej. api.proveedor.pe): la ruta puede llevar identificadores de cuenta. */
  host: string | null
  configuradoEn: Date | null
  /** Sin clave maestra en el servidor no se puede guardar nada. */
  claveMaestra: boolean
}

export async function estadoConfigPse(db: TenantPrismaClient): Promise<EstadoPse> {
  const t = await db.tenant.findFirstOrThrow({ select: { pseEndpointUrl: true, pseTokenEnc: true, pseConfiguredAt: true } })
  let host: string | null = null
  try { host = t.pseEndpointUrl ? new URL(t.pseEndpointUrl).hostname : null } catch { host = null }
  return {
    configurado: !!t.pseEndpointUrl && !!t.pseTokenEnc,
    host, configuradoEn: t.pseConfiguredAt, claveMaestra: hayClaveMaestra(),
  }
}

export async function guardarConfigPse(
  db: TenantPrismaClient,
  ctx: TenantContext,
  input: { url: string; token: string },
  ahora: Date = new Date(),
): Promise<void> {
  exigir(ctx, 'config.fiscal')

  const token = input.token.trim()
  if (token.length < 8 || token.length > 2000) {
    throw new BusinessError('INVALID_DOCUMENT', 'El token del proveedor no parece válido.')
  }
  let url: URL
  try { url = await validarUrlPse(input.url) } catch (e) {
    if (e instanceof UrlNoPermitida) throw new BusinessError('INVALID_DOCUMENT', `URL del proveedor: ${e.message}`)
    throw e
  }
  if (!hayClaveMaestra()) {
    throw new BusinessError('INVALID_DOCUMENT', 'El servidor no tiene configurada la clave para guardar credenciales de forma segura. Avisa a soporte.')
  }

  const tokenEnc = cifrar(token, ctx.tenantId)
  const limpia = url.toString().replace(/\/+$/, '')
  await db.$transaction(async (tx) => {
    const t = tx as unknown as TenantPrismaClient
    const antes = await t.tenant.findFirstOrThrow({ select: { id: true, pseEndpointUrl: true } })
    await t.tenant.update({
      where: { id: antes.id },
      data: { pseEndpointUrl: limpia, pseTokenEnc: tokenEnc, pseConfiguredAt: ahora },
    })
    await t.auditLog.create({
      data: {
        tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role,
        action: 'pse.configurar', entityType: 'Tenant', entityId: antes.id,
        // Nunca el token; del URL solo el host.
        before: { host: antes.pseEndpointUrl ? new URL(antes.pseEndpointUrl).hostname : null },
        after: { host: url.hostname },
        impersonationId: ctx.impersonationId ?? null,
      },
    })
  })
}

export async function quitarConfigPse(db: TenantPrismaClient, ctx: TenantContext): Promise<void> {
  exigir(ctx, 'config.fiscal')
  const t = await db.tenant.findFirstOrThrow({ select: { id: true } })
  await db.tenant.update({ where: { id: t.id }, data: { pseEndpointUrl: null, pseTokenEnc: null, pseConfiguredAt: null } })
  await db.auditLog.create({
    data: {
      tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role,
      action: 'pse.quitar', entityType: 'Tenant', entityId: t.id, impersonationId: ctx.impersonationId ?? null,
    },
  })
}

/** Las credenciales descifradas, SOLO para usarlas en el servidor. `null` si no hay. */
export async function credencialesPseDelNegocio(
  db: TenantPrismaClient,
  tenantId: string,
): Promise<CredencialesProveedor | null> {
  const t = await db.tenant.findFirstOrThrow({ select: { pseEndpointUrl: true, pseTokenEnc: true } })
  if (!t.pseEndpointUrl || !t.pseTokenEnc) return null
  try {
    return { usuario: '', clave: '', modoPruebas: false, urlBase: t.pseEndpointUrl, token: descifrar(t.pseTokenEnc, tenantId) }
  } catch (e) {
    if (e instanceof ClaveMaestraAusente || e instanceof CifradoInvalido) {
      throw new BusinessError('INVALID_DOCUMENT', 'No se pudieron leer las credenciales del proveedor de facturación. Vuelve a guardarlas.')
    }
    throw e
  }
}

/** «Probar conexión» con lo ya guardado. */
export async function probarConexionPse(
  db: TenantPrismaClient,
  ctx: TenantContext,
  proveedor: ProveedorFacturacion = obtenerProveedor('pse-rest'),
): Promise<{ ok: boolean; mensaje: string; certificadoVenceEn?: string }> {
  exigir(ctx, 'config.fiscal')
  const cred = await credencialesPseDelNegocio(db, ctx.tenantId)
  if (!cred) throw new BusinessError('INVALID_DOCUMENT', 'Primero guarda la URL y el token del proveedor.')
  try {
    return await proveedor.verificarCredenciales(cred)
  } catch (e) {
    if (e instanceof Error && e.name === 'ErrorConfiguracionProveedor') return { ok: false, mensaje: e.message }
    throw e
  }
}
