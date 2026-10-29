import { validarRuc } from '@/lib/documentos'
import { BusinessError } from '@/lib/errors'
import { prisma } from '@/lib/prisma'
import { modoFiscal, type ModoFiscal } from '@/features/invoicing/modo-fiscal'
import { distritoExiste } from '@/features/ubigeo/service'

/**
 * Facturación electrónica REAL de un negocio: habilitar, pausar, reanudar, volver a ensayo.
 *
 *   ENSAYO ──habilitar──▶ REAL ──pausar──▶ PAUSADO
 *      ▲                    ▲  ◀──reanudar──┘
 *      └──volver a ensayo───┘ (solo si no se emitió ni un documento real)
 *
 * «Apagar» ya no existe: apagar un negocio que ya emite documentos reales haría que
 * sus clientes empezaran a recibir documentos de prueba sin valor. PAUSAR solo detiene
 * el ENVÍO: la numeración sigue siendo real y los comprobantes esperan hasta reanudar.
 *
 * Solo lo toca un SuperAdmin. `realBillingEnabledAt` NO se borra al pausar: guarda desde
 * cuándo el negocio emite en serie real, y de él depende qué serie usa.
 */

export type AccionFiscal = 'habilitar' | 'pausar' | 'reanudar' | 'volver_a_ensayo'

interface Actor { id: string; email: string }

/**
 * Documentos emitidos en serie REAL antes de que existiera el modo ensayo (o, tras habilitar,
 * documentos reales). Para un negocio nunca habilitado son los del MODELO ANTIGUO: números
 * de una serie real que SUNAT nunca vio y que llevan un cliente en la mano.
 */
export async function contarDocumentosEnSerieReal(tenantId: string): Promise<number> {
  return prisma.taxDocument.count({ where: { tenantId, isTrial: false } })
}

/** Qué le falta a un negocio para poder habilitar la facturación real. Vacío = listo. */
export async function faltantesParaHabilitar(tenantId: string): Promise<string[]> {
  const t = await prisma.tenant.findFirst({
    where: { id: tenantId, deletedAt: null },
    select: {
      isDemo: true, taxId: true, realBillingEnabledAt: true, sunatCredential: { select: { id: true } },
      branches: { where: { isActive: true, deletedAt: null }, select: { name: true, address: true, ubigeo: true } },
    },
  })
  if (!t) throw new BusinessError('TENANT_MISMATCH', 'Cuenta no encontrada.')
  if (t.isDemo) throw new BusinessError('FORBIDDEN_ROLE', 'Una cuenta de demostración nunca usa facturación real.')

  const f: string[] = []
  if (!t.taxId || !validarRuc(t.taxId).valido) f.push('RUC del negocio válido')
  if (!t.sunatCredential) f.push('credenciales de SUNAT cargadas (certificado digital y usuario SOL)')
  if (t.branches.length === 0) f.push('al menos una sucursal activa')
  for (const b of t.branches) {
    if (!b.address || b.address.trim().length < 8) f.push(`dirección completa en la sucursal «${b.name}»`)
    if (!b.ubigeo || !/^\d{6}$/.test(b.ubigeo)) f.push(`ubigeo en la sucursal «${b.name}»`)
    else if ((await distritoExiste(b.ubigeo)) === false) f.push(`ubigeo válido en la sucursal «${b.name}» (${b.ubigeo} no está en el catálogo)`)
  }
  // El modelo antiguo: si ya hay documentos en serie real sin haber habilitado nunca, NO se
  // reubican solos como pruebas (puede haber clientes con esos papeles): requiere revisión contable.
  if (!t.realBillingEnabledAt) {
    const heredados = await contarDocumentosEnSerieReal(tenantId)
    if (heredados > 0) {
      f.push(
        `cierre de ${heredados} documento(s) emitidos con el modelo anterior, que ocupan la serie real sin haber sido enviados nunca ` +
          '(no se reubican solos: requiere la revisión de un contador y la confirmación del SuperAdmin)',
      )
    }
  }
  return f
}

export async function cambiarFacturacionReal(
  input: { tenantId: string; accion: AccionFiscal; reason: string },
  actor: Actor,
  ahora: Date = new Date(),
): Promise<{ modo: ModoFiscal }> {
  const t = await prisma.tenant.findFirst({
    where: { id: input.tenantId, deletedAt: null },
    select: { id: true, isDemo: true, realBillingEnabledAt: true, realBillingPausedAt: true },
  })
  if (!t) throw new BusinessError('TENANT_MISMATCH', 'Cuenta no encontrada.')
  if (t.isDemo) throw new BusinessError('FORBIDDEN_ROLE', 'Una cuenta de demostración nunca usa facturación real.')

  const antes = modoFiscal(t)
  const invalida = (m: string) => new BusinessError('INVALID_DOCUMENT', m)
  let where: Record<string, unknown>
  let data: Record<string, unknown>

  switch (input.accion) {
    case 'habilitar': {
      if (antes !== 'ENSAYO') throw invalida('La facturación real ya está habilitada para este negocio.')
      const faltan = await faltantesParaHabilitar(t.id)
      if (faltan.length > 0) throw new BusinessError('INVALID_DOCUMENT', `No se puede habilitar todavía. Falta: ${faltan.join('; ')}.`, { faltantes: faltan.length })
      where = { realBillingEnabledAt: null }
      data = { realBillingEnabledAt: ahora, realBillingPausedAt: null }
      break
    }
    case 'pausar':
      if (antes !== 'REAL') throw invalida(antes === 'PAUSADO' ? 'Los envíos ya están en pausa.' : 'Solo se pausa el envío de un negocio con la facturación real habilitada.')
      where = { realBillingEnabledAt: { not: null }, realBillingPausedAt: null }
      data = { realBillingPausedAt: ahora }
      break
    case 'reanudar':
      if (antes !== 'PAUSADO') throw invalida('Los envíos no están en pausa.')
      where = { realBillingPausedAt: { not: null } }
      data = { realBillingPausedAt: null }
      break
    case 'volver_a_ensayo': {
      if (antes === 'ENSAYO') throw invalida('El negocio ya está en modo ensayo.')
      const reales = await contarDocumentosEnSerieReal(t.id)
      if (reales > 0) {
        throw new BusinessError('INVALID_DOCUMENT', `No se puede volver a ensayo: ya se emitieron ${reales} documento(s) en serie real. Para detener el envío usa «pausar».`, { reales })
      }
      where = { realBillingEnabledAt: { not: null } }
      data = { realBillingEnabledAt: null, realBillingPausedAt: null }
      break
    }
  }

  // Atómico sobre el estado previo: dos SuperAdmin a la vez no se pisan ni auditan dos veces.
  const r = await prisma.tenant.updateMany({ where: { id: t.id, ...where }, data })
  if (r.count !== 1) throw invalida('El estado cambió mientras tanto. Recarga e inténtalo de nuevo.')

  // Si volvemos a ensayo, un documento real pudo emitirse justo entre la comprobación y el cambio:
  // se revisa de nuevo y, si ocurrió, se deshace en lugar de dejar documentos reales en un negocio en ensayo.
  if (input.accion === 'volver_a_ensayo' && (await contarDocumentosEnSerieReal(t.id)) > 0) {
    await prisma.tenant.update({ where: { id: t.id }, data: { realBillingEnabledAt: t.realBillingEnabledAt, realBillingPausedAt: t.realBillingPausedAt } })
    throw invalida('Se emitió un documento en serie real mientras se cambiaba el modo. No se pudo volver a ensayo.')
  }

  const despues = modoFiscal({ isDemo: false, realBillingEnabledAt: (data.realBillingEnabledAt as Date | null | undefined) === undefined ? t.realBillingEnabledAt : (data.realBillingEnabledAt as Date | null), realBillingPausedAt: (data.realBillingPausedAt as Date | null | undefined) === undefined ? t.realBillingPausedAt : (data.realBillingPausedAt as Date | null) })
  await prisma.auditLog.create({
    data: {
      tenantId: t.id, actorId: actor.id, actorRole: 'SUPERADMIN', actorEmail: actor.email,
      action: `tenant.facturacion_real.${input.accion}`,
      entityType: 'Tenant', entityId: t.id, reason: input.reason,
      before: { modo: antes }, after: { modo: despues },
    },
  })
  return { modo: despues }
}

/** Umbrales de alerta de envío de un negocio (NULL = valor por defecto de la plataforma). */
export async function fijarUmbralesAlerta(
  input: { tenantId: string; warnHours: number | null; criticalHours: number | null; reason: string },
  actor: Actor,
): Promise<void> {
  const { warnHours: w, criticalHours: c } = input
  for (const [n, v] of [['aviso', w], ['crítico', c]] as const) {
    if (v !== null && (!Number.isInteger(v) || v < 1 || v > 24 * 90)) {
      throw new BusinessError('INVALID_DOCUMENT', `El umbral ${n} debe ser un número entero de horas entre 1 y ${24 * 90}.`)
    }
  }
  if (w !== null && c !== null && w >= c) {
    throw new BusinessError('INVALID_DOCUMENT', 'El umbral de aviso tiene que ser menor que el crítico.')
  }
  const t = await prisma.tenant.findFirst({ where: { id: input.tenantId, deletedAt: null }, select: { id: true, fiscalAlertWarnHours: true, fiscalAlertCriticalHours: true } })
  if (!t) throw new BusinessError('TENANT_MISMATCH', 'Cuenta no encontrada.')
  await prisma.tenant.update({ where: { id: t.id }, data: { fiscalAlertWarnHours: w, fiscalAlertCriticalHours: c } })
  await prisma.auditLog.create({
    data: {
      tenantId: t.id, actorId: actor.id, actorRole: 'SUPERADMIN', actorEmail: actor.email,
      action: 'tenant.facturacion_real.umbrales', entityType: 'Tenant', entityId: t.id, reason: input.reason,
      before: { avisoHoras: t.fiscalAlertWarnHours, criticoHoras: t.fiscalAlertCriticalHours }, after: { avisoHoras: w, criticoHoras: c },
    },
  })
}
