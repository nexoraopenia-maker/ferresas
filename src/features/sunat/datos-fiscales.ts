import { validarRuc } from '@/lib/documentos'
import { BusinessError } from '@/lib/errors'
import { camposDeColision, P2002_UNIQUE } from '@/lib/prisma-errors'
import { exigir } from '@/lib/puede'
import type { TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { Prisma } from '@/generated/prisma/client'

/**
 * Datos fiscales del propio negocio: RUC (`Tenant.taxId`) y razón social (`Tenant.legalName`). Los pide la conexión con SUNAT (el certificado debe ser del mismo RUC) y salen
 * en cada comprobante. Solo el dueño (`config.fiscal`); nunca durante una suplantación de soporte.
 *
 * El RUC identifica a UNA persona jurídica y es único en todo el sistema. Una vez que el negocio tiene credenciales de SUNAT cargadas, facturación real habilitada o comprobantes
 * reales emitidos, ya NO se cambia desde aquí (saldría un RUC distinto al de los papeles ya emitidos o al del certificado): lo hace soporte.
 */

export interface DatosFiscales {
  ruc: string | null
  razonSocial: string | null
  /** `null` = se puede editar; si no, el motivo por el que el RUC está bloqueado. */
  rucBloqueadoPor: string | null
}

async function motivoDeBloqueo(db: TenantPrismaClient, tenant: { taxId: string | null; realBillingEnabledAt: Date | null }): Promise<string | null> {
  if (!tenant.taxId) return null
  if (tenant.realBillingEnabledAt) return 'La facturación real ya está habilitada: el RUC solo lo cambia soporte.'
  if (await db.sunatCredential.count() > 0) return 'Hay un certificado cargado para este RUC. Quita el certificado antes de cambiarlo.'
  // (Los comprobantes dependen de la sucursal: quien tiene `config.fiscal` es el dueño, que ve todas. Y con facturación real habilitada ya se cortó arriba.)
  if (await db.taxDocument.count({ where: { isTrial: false } }) > 0) return 'Ya hay comprobantes reales emitidos con este RUC: solo lo cambia soporte.'
  return null
}

export async function leerDatosFiscales(db: TenantPrismaClient): Promise<DatosFiscales> {
  const t = await db.tenant.findFirstOrThrow({ select: { taxId: true, legalName: true, realBillingEnabledAt: true } })
  return { ruc: t.taxId, razonSocial: t.legalName, rucBloqueadoPor: await motivoDeBloqueo(db, t) }
}

export async function guardarDatosFiscales(
  db: TenantPrismaClient, ctx: TenantContext, input: { ruc: string; razonSocial: string },
): Promise<DatosFiscales> {
  exigir(ctx, 'config.fiscal')
  if (ctx.impersonationId) throw new BusinessError('FORBIDDEN_ROLE', 'Durante una suplantación de soporte no se pueden cambiar los datos fiscales: los cambia el dueño.')
  const ruc = input.ruc.replace(/\s+/g, '')
  const razonSocial = input.razonSocial.replace(/\s+/g, ' ').trim()
  if (!validarRuc(ruc).valido) throw new BusinessError('INVALID_DOCUMENT', 'El RUC no es válido: son 11 dígitos y el último es de control. Revísalo.')
  if (razonSocial.length < 3 || razonSocial.length > 200) throw new BusinessError('INVALID_DOCUMENT', 'Escribe la razón social tal como figura en SUNAT (de 3 a 200 caracteres).')

  const t = await db.tenant.findFirstOrThrow({ select: { taxId: true, legalName: true, realBillingEnabledAt: true } })
  if (t.taxId && t.taxId !== ruc) {
    const bloqueo = await motivoDeBloqueo(db, t)
    if (bloqueo) throw new BusinessError('INVALID_DOCUMENT', bloqueo)
  }
  try {
    await db.$transaction(async (tx) => {
      const x = tx as unknown as TenantPrismaClient
      await x.tenant.updateMany({ where: { id: ctx.tenantId }, data: { taxId: ruc, legalName: razonSocial } })
      await x.auditLog.create({
        data: {
          tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role,
          action: 'fiscal.datos_guardados', entityType: 'Tenant', entityId: ctx.tenantId,
          before: { ruc: t.taxId, razonSocial: t.legalName }, after: { ruc, razonSocial }, impersonationId: ctx.impersonationId ?? null,
        },
      })
    })
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === P2002_UNIQUE && camposDeColision(e).includes('taxId')) {
      throw new BusinessError('DUPLICATE_CODE', 'Ese RUC ya está registrado en otra cuenta. Si es el tuyo, contacta a soporte.')
    }
    throw e
  }
  return { ruc, razonSocial, rucBloqueadoPor: await motivoDeBloqueo(db, { taxId: ruc, realBillingEnabledAt: t.realBillingEnabledAt }) }
}
