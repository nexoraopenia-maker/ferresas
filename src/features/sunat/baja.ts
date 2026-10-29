import type { DocumentType, TaxDocumentStatus } from '@/generated/prisma/enums'
import { BusinessError } from '@/lib/errors'
import { diaLocal } from '@/lib/periodos'
import { camposDeColision, P2002_UNIQUE } from '@/lib/prisma-errors'
import { exigir } from '@/lib/puede'
import type { TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { Prisma } from '@/generated/prisma/client'
import { modoFiscal } from '@/features/invoicing/modo-fiscal'
import { identificadorDeBaja, MOTIVO_BAJA_MAX } from './baja-xml'
import { dentroDelPlazoDeBaja, diasEntre, PLAZO_BAJA_DIAS } from './plazos'

/**
 * Comunicación de baja (S4): pedir a SUNAT que anule un comprobante ya aceptado, dentro del plazo. Aquí vive la SOLICITUD (reglas y alta); el envío y la consulta del ticket
 * los hace la cola (`cola-fiscal/procesar-baja.ts`).
 *
 * ⚠️ Qué documentos se pueden dar de baja, el plazo (7 días calendario, del dueño) y la forma de contarlo están SIN verificar con la norma (docs/SUNAT-SUPUESTOS.md).
 * Lo que decidimos nosotros y es conservador:
 *  · Solo facturas y notas de serie F. Una boleta no se da de baja por aquí: se informa en el resumen diario (todavía no existe en el sistema).
 *  · Solo comprobantes REALES (nunca de prueba) ya ACEPTADOS u OBSERVADOS por SUNAT.
 *  · Una factura con una nota viva no se da de baja: la corrige la nota, y las dos cosas a la vez se contradicen.
 *  · Dar de baja es solo FISCAL: la venta, el stock y el dinero no se tocan (para eso está la devolución).
 */

export const ESTADOS_DE_BAJA_VIVA = ['PENDIENTE', 'ENVIADA', 'ACEPTADA'] as const

export interface EntradaBaja {
  documentType: DocumentType
  series: string
  isTrial: boolean
  status: TaxDocumentStatus
  /** Día de emisión y día de hoy, en la zona del negocio (`AAAA-MM-DD`). */
  diaEmision: string
  diaHoy: string
  /** Estado de otra solicitud del mismo comprobante, si hay (la más reciente). */
  bajaPrevia: { status: string; ticket: string | null } | null
  /** Notas de crédito o débito no rechazadas que corrigen este comprobante. */
  notasVivas: number
}

/** Por qué NO se puede dar de baja, o `null` si se puede. Pura. */
export function motivoDeNoBaja(e: EntradaBaja): string | null {
  if (e.isTrial) return 'Este es un documento de prueba, sin valor tributario: no se comunica a SUNAT.'
  const esNota = e.documentType === 'NOTA_CREDITO' || e.documentType === 'NOTA_DEBITO'
  if (e.documentType !== 'FACTURA' && !esNota) {
    return 'Solo se da de baja una factura (o una nota de una factura). Las boletas se informan en el resumen diario.'
  }
  if (esNota && !e.series.startsWith('F')) return 'Una nota de una boleta no se da de baja por aquí: se informa en el resumen diario.'
  if (e.status === 'ANULADO') return 'Este comprobante ya está anulado.'
  if (e.status !== 'ACEPTADO' && e.status !== 'OBSERVADO') return 'Solo se da de baja un comprobante que SUNAT ya aceptó.'
  if (!dentroDelPlazoDeBaja(e.diaEmision, e.diaHoy)) {
    return `Venció el plazo de ${PLAZO_BAJA_DIAS} días para dar de baja este comprobante (se emitió hace ${diasEntre(e.diaEmision, e.diaHoy)} días). Corrígelo con una nota de crédito.`
  }
  if (e.bajaPrevia && (ESTADOS_DE_BAJA_VIVA as readonly string[]).includes(e.bajaPrevia.status)) return 'Este comprobante ya tiene una baja en curso.'
  if (e.bajaPrevia?.status === 'AGOTADA' && e.bajaPrevia.ticket) {
    return 'La baja anterior ya tiene ticket de SUNAT pero no se pudo consultar: reintenta su consulta en vez de pedir otra.'
  }
  if (e.notasVivas > 0) return 'Este comprobante tiene una nota de crédito o débito: se corrige con la nota, no con una baja.'
  return null
}

export function motivoValido(texto: string): string {
  const m = texto.replace(/\s+/g, ' ').trim()
  if (!m) throw new BusinessError('INVALID_DOCUMENT', 'Escribe el motivo de la baja.')
  if (m.length > MOTIVO_BAJA_MAX) throw new BusinessError('INVALID_DOCUMENT', `El motivo admite hasta ${MOTIVO_BAJA_MAX} caracteres.`)
  return m
}

export interface BajaSolicitada {
  id: string
  identificador: string
}

/**
 * Pide la baja de un comprobante: valida, le asigna su identificador del día (`RA-AAAAMMDD-N`) y la deja en la cola (PENDIENTE). Nada sale a SUNAT desde aquí.
 */
export async function solicitarBajaComprobante(
  db: TenantPrismaClient, ctx: TenantContext, taxDocumentId: string, motivo: string, deps: { ahora?: Date } = {},
): Promise<BajaSolicitada> {
  exigir(ctx, 'comprobantes.dar_baja')
  if (ctx.impersonationId) throw new BusinessError('FORBIDDEN_ROLE', 'Durante una suplantación de soporte no se pueden dar de baja comprobantes: lo hace el negocio.')
  const razon = motivoValido(motivo)
  const ahora = deps.ahora ?? new Date()

  const tenant = await db.tenant.findFirstOrThrow({ select: { isDemo: true, realBillingEnabledAt: true, realBillingPausedAt: true, timezone: true } })
  const modo = modoFiscal(tenant)
  if (modo === 'DEMO') throw new BusinessError('INVALID_DOCUMENT', 'Las cuentas de demostración no comunican bajas a SUNAT.')
  if (modo === 'ENSAYO') throw new BusinessError('INVALID_DOCUMENT', 'La facturación electrónica real todavía no está habilitada para tu negocio.')

  const doc = await db.taxDocument.findFirst({
    where: { id: taxDocumentId },
    select: {
      id: true, documentType: true, series: true, isTrial: true, status: true, issuedAt: true, fullNumber: true,
      bajas: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true, ticket: true } },
      notes: { where: { status: { not: 'RECHAZADO' } }, select: { id: true } },
    },
  })
  if (!doc) throw new BusinessError('NOT_FOUND', 'El comprobante no existe.')

  const diaHoy = diaLocal(tenant.timezone, ahora)
  const no = motivoDeNoBaja({
    documentType: doc.documentType, series: doc.series, isTrial: doc.isTrial, status: doc.status,
    diaEmision: diaLocal(tenant.timezone, doc.issuedAt), diaHoy, bajaPrevia: doc.bajas[0] ?? null, notasVivas: doc.notes.length,
  })
  if (no) throw new BusinessError('INVALID_DOCUMENT', no)

  // El número del día lo da el máximo de hoy + 1; si dos personas piden a la vez, el índice único rechaza a una y se reintenta.
  for (let intento = 0; intento < 4; intento++) {
    const max = await db.taxVoid.aggregate({ where: { issueDay: diaHoy }, _max: { seq: true } })
    const seq = (max._max.seq ?? 0) + 1
    const identificador = identificadorDeBaja(diaHoy, seq)
    try {
      return await db.$transaction(async (tx) => {
        const t = tx as unknown as TenantPrismaClient
        const v = await t.taxVoid.create({
          data: { tenantId: ctx.tenantId, taxDocumentId: doc.id, issueDay: diaHoy, seq, identifier: identificador, reason: razon, requestedBy: ctx.userId, nextAttemptAt: ahora },
          select: { id: true },
        })
        await t.auditLog.create({
          data: {
            tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role,
            action: 'baja.solicitada', entityType: 'TaxDocument', entityId: doc.id,
            before: { status: doc.status }, after: { identificador, motivo: razon, comprobante: doc.fullNumber }, impersonationId: ctx.impersonationId ?? null,
          },
        })
        return { id: v.id, identificador }
      })
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== P2002_UNIQUE) throw e
      const campos = camposDeColision(e)
      // Otra solicitud viva del MISMO comprobante (índice parcial): no es un choque de número.
      if (!campos.includes('identifier') && !campos.includes('seq')) throw new BusinessError('INVALID_DOCUMENT', 'Este comprobante ya tiene una baja en curso.')
    }
  }
  throw new BusinessError('INVALID_DOCUMENT', 'No se pudo asignar el número de la comunicación de baja. Inténtalo de nuevo.')
}

/**
 * Una baja sin respuesta tras todos los reintentos puede volver a intentarse: si ya tiene ticket se vuelve a CONSULTAR; si no, se vuelve a ENVIAR (mismo identificador,
 * el mismo XML firmado lo reconoce SUNAT como la misma comunicación).
 */
export async function reintentarBaja(db: TenantPrismaClient, ctx: TenantContext, taxDocumentId: string, deps: { ahora?: Date } = {}): Promise<void> {
  exigir(ctx, 'comprobantes.dar_baja')
  if (ctx.impersonationId) throw new BusinessError('FORBIDDEN_ROLE', 'Durante una suplantación de soporte no se pueden reintentar bajas.')
  const ahora = deps.ahora ?? new Date()
  const v = await db.taxVoid.findFirst({ where: { taxDocumentId, status: 'AGOTADA' }, orderBy: { createdAt: 'desc' }, select: { id: true, ticket: true } })
  if (!v) throw new BusinessError('NOT_FOUND', 'Este comprobante no tiene una baja agotada para reintentar.')
  await db.$transaction(async (tx) => {
    const t = tx as unknown as TenantPrismaClient
    const r = await t.taxVoid.updateMany({
      where: { id: v.id, status: 'AGOTADA' },
      data: { status: v.ticket ? 'ENVIADA' : 'PENDIENTE', attempts: 0, nextAttemptAt: ahora, exhaustedAt: null, lockedUntil: null, lockedBy: null, lastError: null },
    })
    if (r.count !== 1) return
    await t.auditLog.create({
      data: {
        tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role,
        action: 'baja.reintentada', entityType: 'TaxDocument', entityId: taxDocumentId, after: { conTicket: Boolean(v.ticket) }, impersonationId: ctx.impersonationId ?? null,
      },
    })
  })
}

export interface EstadoDeBaja {
  identificador: string
  status: string
  motivo: string
  mensaje: string | null
  ticket: string | null
  solicitadaEn: Date
}

/** La baja más reciente de cada comprobante (para la lista). */
export async function bajasDeComprobantes(db: TenantPrismaClient, taxDocumentIds: string[]): Promise<Record<string, EstadoDeBaja>> {
  if (taxDocumentIds.length === 0) return {}
  const filas = await db.taxVoid.findMany({
    where: { taxDocumentId: { in: taxDocumentIds } }, orderBy: { createdAt: 'desc' },
    select: { taxDocumentId: true, identifier: true, status: true, reason: true, responseMessage: true, lastError: true, ticket: true, requestedAt: true },
  })
  const salida: Record<string, EstadoDeBaja> = {}
  for (const f of filas) {
    if (salida[f.taxDocumentId]) continue
    salida[f.taxDocumentId] = { identificador: f.identifier, status: f.status, motivo: f.reason, mensaje: f.responseMessage ?? f.lastError, ticket: f.ticket, solicitadaEn: f.requestedAt }
  }
  return salida
}
