import { validarRuc } from '@/lib/documentos'
import { BusinessError } from '@/lib/errors'
import { prisma } from '@/lib/prisma'
import { distritoExiste } from '@/features/ubigeo/service'

/**
 * Interruptor «facturación real habilitada» de un negocio.
 *
 * Apagado por defecto. Encendido, el negocio puede enviar comprobantes a su
 * proveedor (PSE/OSE); apagado, emite y numera pero NADA sale. Solo lo toca un
 * SuperAdmin (no el dueño): el criterio para encenderlo es haber validado en el
 * sandbox del proveedor, y eso lo sabe quien opera la plataforma.
 */

interface Actor { id: string; email: string }

/** Qué le falta a un negocio para poder encender la facturación real. Vacío = listo. */
export async function faltantesParaHabilitar(tenantId: string): Promise<string[]> {
  const t = await prisma.tenant.findFirst({
    where: { id: tenantId, deletedAt: null },
    select: {
      isDemo: true, taxId: true, pseConfiguredAt: true,
      branches: { where: { isActive: true, deletedAt: null }, select: { name: true, address: true, ubigeo: true } },
    },
  })
  if (!t) throw new BusinessError('TENANT_MISMATCH', 'Cuenta no encontrada.')
  if (t.isDemo) throw new BusinessError('FORBIDDEN_ROLE', 'Una cuenta de demostración nunca usa facturación real.')

  const f: string[] = []
  if (!t.taxId || !validarRuc(t.taxId).valido) f.push('RUC del negocio válido')
  if (!t.pseConfiguredAt) f.push('proveedor PSE configurado (URL y token)')
  if (t.branches.length === 0) f.push('al menos una sucursal activa')
  for (const b of t.branches) {
    if (!b.address || b.address.trim().length < 8) f.push(`dirección completa en la sucursal «${b.name}»`)
    if (!b.ubigeo || !/^\d{6}$/.test(b.ubigeo)) f.push(`ubigeo en la sucursal «${b.name}»`)
    else if ((await distritoExiste(b.ubigeo)) === false) f.push(`ubigeo válido en la sucursal «${b.name}» (${b.ubigeo} no está en el catálogo)`)
  }
  return f
}

export async function cambiarFacturacionReal(
  input: { tenantId: string; habilitar: boolean; reason: string },
  actor: Actor,
  ahora: Date = new Date(),
): Promise<{ habilitada: boolean }> {
  const t = await prisma.tenant.findFirst({
    where: { id: input.tenantId, deletedAt: null }, select: { id: true, name: true, isDemo: true, realBillingEnabledAt: true },
  })
  if (!t) throw new BusinessError('TENANT_MISMATCH', 'Cuenta no encontrada.')

  if (input.habilitar) {
    if (t.realBillingEnabledAt) throw new BusinessError('INVALID_DOCUMENT', 'La facturación real ya está habilitada para este negocio.')
    const faltan = await faltantesParaHabilitar(t.id)
    if (faltan.length > 0) {
      throw new BusinessError('INVALID_DOCUMENT', `No se puede habilitar todavía. Falta: ${faltan.join('; ')}.`, { faltantes: faltan.length })
    }
  } else if (!t.realBillingEnabledAt) {
    throw new BusinessError('INVALID_DOCUMENT', 'La facturación real ya está apagada para este negocio.')
  }

  // Atómico sobre el estado previo: dos SuperAdmin a la vez no se pisan ni auditan dos veces.
  const r = await prisma.tenant.updateMany({
    where: { id: t.id, realBillingEnabledAt: input.habilitar ? null : { not: null } },
    data: { realBillingEnabledAt: input.habilitar ? ahora : null },
  })
  if (r.count !== 1) throw new BusinessError('INVALID_DOCUMENT', 'El estado cambió mientras tanto. Recarga e inténtalo de nuevo.')

  await prisma.auditLog.create({
    data: {
      tenantId: t.id, actorId: actor.id, actorRole: 'SUPERADMIN', actorEmail: actor.email,
      action: input.habilitar ? 'tenant.facturacion_real.habilitar' : 'tenant.facturacion_real.apagar',
      entityType: 'Tenant', entityId: t.id, reason: input.reason,
      before: { habilitada: !input.habilitar }, after: { habilitada: input.habilitar },
    },
  })
  return { habilitada: input.habilitar }
}
