import { hayClaveMaestra } from '@/lib/cifrado'
import { validarRuc } from '@/lib/documentos'
import { BusinessError } from '@/lib/errors'
import { diaLocal } from '@/lib/periodos'
import { prisma } from '@/lib/prisma'
import { dentroDelPlazoDeEnvio } from '@/features/sunat/plazos'

/**
 * Pase a PRODUCCIÓN de SUNAT (S5): cambiar la conexión de un negocio del ambiente de pruebas (BETA) al real. Es un poder SOLO del SuperAdmin, aparte de
 * «habilitar la facturación real» (que decide la serie y si se envía): aquí se decide A QUÉ ambiente de SUNAT va lo que se envía.
 *
 *   BETA ──pasar a producción (con todas las comprobaciones)──▶ PRODUCCION
 *     ▲                                                              │
 *     └──volver a pruebas (solo si no salió ni un comprobante real)──┘
 *
 * Mientras la conexión está en BETA los comprobantes REALES no salen (envio.ts, supuesto #18): quedan PENDIENTES y la cola gasta intentos. Al pasar a producción
 * lo pendiente NO se envía a ciegas: lo que está dentro del plazo de envío vuelve a la cola con intentos nuevos; lo que ya lo superó se retiene (AGOTADO, visible en
 * la pantalla del negocio, con una advertencia) y solo sale si una persona lo envía a mano. Las bajas pendientes vuelven a la cola con intentos nuevos (su plazo lo
 * vuelve a comprobar la cola antes de enviar).
 *
 * ⚠️ Qué hace falta para «estar listo» es criterio nuestro (docs/SUNAT-SUPUESTOS.md #28): nada de esto es una exigencia de SUNAT. La PRUEBA DE CONEXIÓN no es requisito del pase: se hace ya en producción
 * y es la compuerta del primer envío (S5b, #29).
 */

const DIA_MS = 86_400_000
const DIAS_AVISO_CERTIFICADO = 30

interface Actor { id: string; email: string }

export interface EvaluacionPase {
  ambiente: 'BETA' | 'PRODUCCION' | null
  /** Vacío = listo. Cada uno impide el pase. */
  faltantes: string[]
  /** No impiden el pase, pero el SuperAdmin debe leerlas. */
  advertencias: string[]
  /** Comprobantes reales PENDIENTES: los que aún están dentro del plazo de envío y los que ya lo superaron. */
  pendientes: { enPlazo: number; fueraDePlazo: number }
  bajasPendientes: number
}

async function cargar(tenantId: string) {
  const t = await prisma.tenant.findFirst({
    where: { id: tenantId, deletedAt: null },
    select: { id: true, isDemo: true, taxId: true, timezone: true, realBillingEnabledAt: true, sunatCredential: {
      select: { ambiente: true, certRuc: true, certValidFrom: true, certValidTo: true, lastTestAt: true, lastTestOk: true },
    } },
  })
  if (!t) throw new BusinessError('TENANT_MISMATCH', 'Cuenta no encontrada.')
  if (t.isDemo) throw new BusinessError('FORBIDDEN_ROLE', 'Una cuenta de demostración nunca usa SUNAT real.')
  return t
}

/** Qué le falta a un negocio para pasar a producción y qué pasaría con lo pendiente. No cambia nada. */
export async function evaluarPaseASunatProduccion(tenantId: string, ahora: Date = new Date()): Promise<EvaluacionPase> {
  const t = await cargar(tenantId)
  const c = t.sunatCredential
  const faltantes: string[] = []
  const advertencias: string[] = []

  if (!t.taxId || !validarRuc(t.taxId).valido) faltantes.push('RUC del negocio válido')
  if (!t.realBillingEnabledAt) faltantes.push('facturación real habilitada (el negocio sigue en modo ensayo)')
  if (!hayClaveMaestra()) faltantes.push('clave maestra de cifrado configurada en el servidor')

  if (!c) {
    faltantes.push('credenciales de SUNAT cargadas (certificado digital y usuario SOL)')
  } else {
    if (c.ambiente === 'PRODUCCION') faltantes.push('la conexión ya está en producción')
    if (ahora > c.certValidTo) faltantes.push('certificado digital vigente (está VENCIDO)')
    else if (ahora < c.certValidFrom) faltantes.push('certificado digital vigente (todavía no empieza su vigencia)')
    else if (c.certValidTo.getTime() - ahora.getTime() <= DIAS_AVISO_CERTIFICADO * DIA_MS) {
      advertencias.push(`El certificado digital vence el ${c.certValidTo.toISOString().slice(0, 10)} (en ${Math.max(0, Math.ceil((c.certValidTo.getTime() - ahora.getTime()) / DIA_MS))} días): renuévalo pronto.`)
    }
    if (!c.certRuc) faltantes.push('RUC legible en el certificado (no se pudo leer, así que no se puede comprobar que sea del negocio)')
    else if (t.taxId && c.certRuc !== t.taxId) faltantes.push(`certificado del mismo RUC que el negocio (el certificado es del ${c.certRuc} y el negocio es ${t.taxId})`)
    // La prueba de conexión YA NO es requisito del pase: BETA no sirve para probar credenciales (las acepta todas) ni ofrece la consulta de CDR. La conexión se prueba ya en
    // PRODUCCIÓN, y hasta entonces ningún comprobante sale (ver `ConexionSinProbar` en invoicing/envio.ts).
    advertencias.push('Tras el pase, ningún comprobante sale a SUNAT real hasta que el dueño pulse «Probar conexión» y salga bien (o soporte la confirme a mano). Pídele que la haga enseguida.')
  }

  const pend = await prisma.taxDocument.findMany({ where: { tenantId, isTrial: false, status: 'PENDIENTE' }, select: { issuedAt: true }, take: 20_000 })
  const hoy = diaLocal(t.timezone, ahora)
  const enPlazo = pend.filter((d) => dentroDelPlazoDeEnvio(diaLocal(t.timezone, d.issuedAt), hoy)).length
  const fueraDePlazo = pend.length - enPlazo
  if (fueraDePlazo > 0) {
    advertencias.push(`${fueraDePlazo} comprobante(s) pendiente(s) ya superaron el plazo de envío: NO se enviarán solos; quedarán detenidos para que los revises con el contador y, si procede, los envíes a mano.`)
  }
  if (enPlazo > 0) advertencias.push(`${enPlazo} comprobante(s) pendiente(s) dentro del plazo volverán a la cola y se enviarán a SUNAT real apenas se pase a producción.`)
  const bajasPendientes = await prisma.taxVoid.count({ where: { tenantId, status: 'PENDIENTE' } })
  if (bajasPendientes > 0) advertencias.push(`${bajasPendientes} baja(s) pendiente(s) volverán a la cola (su plazo se vuelve a comprobar antes de enviar).`)

  return { ambiente: c?.ambiente ?? null, faltantes, advertencias, pendientes: { enPlazo, fueraDePlazo }, bajasPendientes }
}

export interface ResultadoPase {
  ambiente: 'PRODUCCION'
  reencolados: number
  retenidos: number
  bajasReencoladas: number
}

const MOTIVO_RETENIDO = 'Fuera del plazo de envío al pasar a producción: no se envía solo. Revísalo con el contador y, si procede, envíalo a mano.'

export async function pasarASunatProduccion(
  input: { tenantId: string; reason: string }, actor: Actor, ahora: Date = new Date(),
): Promise<ResultadoPase> {
  const ev = await evaluarPaseASunatProduccion(input.tenantId, ahora)
  if (ev.faltantes.length > 0) {
    throw new BusinessError('INVALID_DOCUMENT', `No se puede pasar a producción todavía. Falta: ${ev.faltantes.join('; ')}.`, { faltantes: ev.faltantes.length })
  }
  const t = await cargar(input.tenantId)

  // Todo o nada: el cambio de ambiente, lo que se reordena en la cola y la auditoría van en UNA transacción.
  return prisma.$transaction(async (tx) => {
    // Atómico sobre el estado previo: dos SuperAdmin a la vez no se pisan ni auditan dos veces. La prueba de conexión se borra: el dueño la repite ya en producción.
    const r = await tx.sunatCredential.updateMany({
      where: { tenantId: t.id, ambiente: 'BETA' },
      data: { ambiente: 'PRODUCCION', lastTestAt: null, lastTestOk: null, lastTestMessage: null, updatedById: actor.id },
    })
    if (r.count !== 1) throw new BusinessError('INVALID_DOCUMENT', 'El estado cambió mientras tanto. Recarga e inténtalo de nuevo.')

    const pend = await tx.taxDocument.findMany({ where: { tenantId: t.id, isTrial: false, status: 'PENDIENTE' }, select: { id: true, issuedAt: true }, take: 20_000 })
    const hoy = diaLocal(t.timezone, ahora)
    const dentro = pend.filter((d) => dentroDelPlazoDeEnvio(diaLocal(t.timezone, d.issuedAt), hoy)).map((d) => d.id)
    const fuera = pend.filter((d) => !dentro.includes(d.id)).map((d) => d.id)

    // Dentro del plazo: la fila vuelve a la cola con intentos nuevos (las que no tienen fila las adopta el worker). Una en curso no se toca.
    const reenc = await tx.fiscalDispatch.updateMany({
      where: { tenantId: t.id, taxDocumentId: { in: dentro }, status: { in: ['PENDIENTE', 'AGOTADO'] } },
      data: { status: 'PENDIENTE', attempts: 0, nextAttemptAt: ahora, exhaustedAt: null, lastError: null, lockedUntil: null, lockedBy: null },
    })
    // Fuera del plazo: se RETIENEN (AGOTADO + motivo). Si no tenían fila se crea retenida, para que el worker no las adopte y las envíe.
    for (const id of fuera) {
      await tx.fiscalDispatch.upsert({
        where: { tenantId_taxDocumentId: { tenantId: t.id, taxDocumentId: id } },
        create: { tenantId: t.id, taxDocumentId: id, idempotencyKey: `fiscal:${t.id}:${id}:ENVIAR`, status: 'AGOTADO', exhaustedAt: ahora, lastError: MOTIVO_RETENIDO },
        update: { status: 'AGOTADO', exhaustedAt: ahora, lastError: MOTIVO_RETENIDO, lockedUntil: null, lockedBy: null },
      })
    }
    const bajas = await tx.taxVoid.updateMany({
      where: { tenantId: t.id, status: 'PENDIENTE' },
      data: { attempts: 0, nextAttemptAt: ahora, lastError: null, lockedUntil: null, lockedBy: null },
    })

    await tx.auditLog.create({
      data: {
        tenantId: t.id, actorId: actor.id, actorRole: 'SUPERADMIN', actorEmail: actor.email,
        action: 'tenant.sunat.produccion', entityType: 'Tenant', entityId: t.id, reason: input.reason,
        before: { ambiente: 'BETA' }, after: { ambiente: 'PRODUCCION', reencolados: reenc.count, retenidos: fuera.length, bajasReencoladas: bajas.count },
      },
    })
    return { ambiente: 'PRODUCCION', reencolados: reenc.count, retenidos: fuera.length, bajasReencoladas: bajas.count }
  })
}

/**
 * Devuelve la conexión a PRUEBAS. Solo si de este negocio no salió ni un comprobante real (con SUNAT ya se enviaron cosas que no se pueden «des-enviar»: para
 * detener el envío está «pausar»).
 */
export async function volverASunatBeta(input: { tenantId: string; reason: string }, actor: Actor): Promise<{ ambiente: 'BETA' }> {
  const t = await cargar(input.tenantId)
  if (t.sunatCredential?.ambiente !== 'PRODUCCION') throw new BusinessError('INVALID_DOCUMENT', 'La conexión no está en producción.')
  const enviados = await prisma.taxDocument.count({ where: { tenantId: t.id, isTrial: false, sentAt: { not: null } } })
  const bajas = await prisma.taxVoid.count({ where: { tenantId: t.id, sentAt: { not: null } } })
  if (enviados + bajas > 0) {
    throw new BusinessError('INVALID_DOCUMENT', `No se puede volver a pruebas: ya salieron ${enviados} comprobante(s) y ${bajas} baja(s) hacia SUNAT real. Para detener el envío usa «pausar».`, { enviados, bajas })
  }
  return prisma.$transaction(async (tx) => {
    const r = await tx.sunatCredential.updateMany({
      where: { tenantId: t.id, ambiente: 'PRODUCCION' },
      data: { ambiente: 'BETA', lastTestAt: null, lastTestOk: null, lastTestMessage: null, updatedById: actor.id },
    })
    if (r.count !== 1) throw new BusinessError('INVALID_DOCUMENT', 'El estado cambió mientras tanto. Recarga e inténtalo de nuevo.')
    // Un comprobante real pudo salir justo entre la comprobación y el cambio: se revisa de nuevo y, si ocurrió, todo se deshace.
    if ((await tx.taxDocument.count({ where: { tenantId: t.id, isTrial: false, sentAt: { not: null } } })) > 0) {
      throw new BusinessError('INVALID_DOCUMENT', 'Salió un comprobante real mientras se cambiaba el ambiente. No se pudo volver a pruebas.')
    }
    await tx.auditLog.create({
      data: {
        tenantId: t.id, actorId: actor.id, actorRole: 'SUPERADMIN', actorEmail: actor.email,
        action: 'tenant.sunat.beta', entityType: 'Tenant', entityId: t.id, reason: input.reason,
        before: { ambiente: 'PRODUCCION' }, after: { ambiente: 'BETA' },
      },
    })
    return { ambiente: 'BETA' as const }
  })
}

/**
 * Escape de SOPORTE: da por probada la conexión de un negocio que YA está en producción cuando la «prueba de conexión» del dueño no puede concluir (p. ej. el servicio de consulta de
 * SUNAT no responde) pero se verificó por otro camino. Solo SuperAdmin, con motivo, auditado. No sirve en BETA ni si ya está probada: no se debilita la compuerta por descuido.
 */
export async function confirmarConexionSunat(
  input: { tenantId: string; reason: string }, actor: Actor, ahora: Date = new Date(),
): Promise<{ confirmada: true }> {
  const t = await cargar(input.tenantId)
  const c = t.sunatCredential
  if (c?.ambiente !== 'PRODUCCION') throw new BusinessError('INVALID_DOCUMENT', 'La conexión no está en producción: no hay nada que confirmar.')
  if (c.lastTestOk === true) throw new BusinessError('INVALID_DOCUMENT', 'La conexión ya figura como probada.')
  return prisma.$transaction(async (tx) => {
    const r = await tx.sunatCredential.updateMany({
      where: { tenantId: t.id, ambiente: 'PRODUCCION', OR: [{ lastTestOk: null }, { lastTestOk: false }] },
      data: { lastTestAt: ahora, lastTestOk: true, lastTestMessage: `Confirmada a mano por soporte (${actor.email}).`, updatedById: actor.id },
    })
    if (r.count !== 1) throw new BusinessError('INVALID_DOCUMENT', 'El estado cambió mientras tanto. Recarga e inténtalo de nuevo.')
    // La compuerta se abre: lo que esperaba sale ya.
    await tx.fiscalDispatch.updateMany({ where: { tenantId: t.id, status: 'PENDIENTE', nextAttemptAt: { gt: ahora } }, data: { nextAttemptAt: ahora } })
    await tx.taxVoid.updateMany({ where: { tenantId: t.id, status: { in: ['PENDIENTE', 'ENVIADA'] }, nextAttemptAt: { gt: ahora } }, data: { nextAttemptAt: ahora } })
    await tx.auditLog.create({
      data: {
        tenantId: t.id, actorId: actor.id, actorRole: 'SUPERADMIN', actorEmail: actor.email,
        action: 'tenant.sunat.conexion_confirmada', entityType: 'Tenant', entityId: t.id, reason: input.reason,
        before: { conexionProbada: false }, after: { conexionProbada: true, manual: true },
      },
    })
    return { confirmada: true as const }
  })
}
