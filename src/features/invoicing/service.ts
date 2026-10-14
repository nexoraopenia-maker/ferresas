import { Prisma } from '@/generated/prisma/client'
import { BusinessError } from '@/lib/errors'
import { hasRole, type TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { claimNextNumber, ensureCounter } from '@/features/pos/sale-service'
import {
  formatFullNumber,
  SERIE_POR_DEFECTO,
  type IssueTaxDocumentInput,
  type UpdateTaxStatusInput,
} from './schemas'

const P2002_UNIQUE = 'P2002'

export interface IssuedDocument {
  id: string
  documentType: string
  series: string
  correlativo: number
  fullNumber: string
  status: string
  total: number
  /** Ya estaba emitido: se devuelve el existente en vez de duplicar. */
  alreadyIssued: boolean
}

function num(d: Prisma.Decimal | number): number {
  return typeof d === 'number' ? d : d.toNumber()
}

/**
 * Emite un comprobante para una venta.
 *
 * ─── LAS TRES REGLAS QUE ESTO HACE CUMPLIR ───────────────────────────────
 *
 * 1. CORRELATIVO SIN HUECOS. El número se reserva con el contador
 *    transaccional (`claimNextNumber`) dentro de la MISMA transacción que
 *    inserta el comprobante. Si el insert falla, el número se devuelve y no
 *    queda quemado. Una serie con huecos es una contingencia tributaria, no
 *    un detalle cosmético.
 *
 * 2. INMUTABILIDAD. Los datos del emisor, del receptor y los importes se
 *    COPIAN al comprobante. Si mañana el cliente corrige su RUC o el dueño
 *    cambia la razón social, el comprobante ya emitido no se altera — que es
 *    justamente lo que un documento tributario significa.
 *
 * 3. UNO POR VENTA. Corregir un comprobante emitido se hace con nota de
 *    crédito, nunca reemplazándolo. Reintentar devuelve el existente.
 */
export async function issueTaxDocument(
  db: TenantPrismaClient,
  ctx: TenantContext,
  input: IssueTaxDocumentInput,
): Promise<IssuedDocument> {
  // Emitir un comprobante compromete al negocio ante la administración
  // tributaria: no es tarea del almacenero de turno.
  if (!hasRole(ctx.role, 'VENDEDOR')) {
    throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para emitir comprobantes.')
  }

  const series = input.series ?? SERIE_POR_DEFECTO[input.documentType]
  const scope = `TAX_${input.documentType}`

  const sale = await db.sale.findFirst({
    where: { id: input.saleId },
    select: {
      id: true,
      number: true,
      status: true,
      subtotal: true,
      taxTotal: true,
      discountTotal: true,
      total: true,
      currency: true,
      customer: {
        select: { docType: true, docNumber: true, name: true, address: true },
      },
      taxDocument: {
        select: {
          id: true, documentType: true, series: true,
          correlativo: true, fullNumber: true, status: true, total: true,
        },
      },
    },
  })

  if (!sale) {
    throw new BusinessError('TENANT_MISMATCH', 'La venta no existe.')
  }

  // Reintento: se devuelve el comprobante que ya existe. No es un error —
  // es lo que pasa cuando el cajero toca dos veces o se le cae la red.
  if (sale.taxDocument) {
    const d = sale.taxDocument
    return {
      id: d.id,
      documentType: d.documentType,
      series: d.series,
      correlativo: d.correlativo,
      fullNumber: d.fullNumber,
      status: d.status,
      total: num(d.total),
      alreadyIssued: true,
    }
  }

  if (sale.status !== 'COMPLETADA') {
    throw new BusinessError(
      'INSUFFICIENT_STOCK',
      'Solo se emite comprobante de una venta completada.',
    )
  }

  // --- Receptor: se prefiere el dato de la BASE sobre el del cuerpo -------
  // El cliente registrado es la fuente fiable; lo que venga en la petición
  // solo rellena lo que falte (venta sin cliente asociado).
  const receiverDocType =
    sale.customer?.docType ?? input.receiverDocType ?? 'SIN_DOCUMENTO'
  const receiverDocNumber = sale.customer?.docNumber ?? input.receiverDocNumber ?? null
  const receiverName = sale.customer?.name ?? input.receiverName ?? null
  const receiverAddress = sale.customer?.address ?? input.receiverAddress ?? null

  // Una FACTURA sin RUC no es un documento válido. Se comprueba contra el
  // dato real, no contra lo que afirme el cuerpo de la petición.
  if (input.documentType === 'FACTURA') {
    if (receiverDocType !== 'RUC' || !receiverDocNumber) {
      throw new BusinessError(
        'INVALID_DOCUMENT',
        'Una factura exige el RUC del cliente. Regístralo o emite una boleta.',
      )
    }
    if (!/^\d{11}$/.test(receiverDocNumber)) {
      throw new BusinessError(
        'INVALID_DOCUMENT',
        'El RUC debe tener 11 dígitos.',
      )
    }
    if (!receiverName) {
      throw new BusinessError(
        'INVALID_DOCUMENT',
        'Una factura exige la razón social del cliente.',
      )
    }
  }

  const tenant = await db.tenant.findFirstOrThrow({
    select: { taxId: true, legalName: true, name: true },
  })

  await ensureCounter(db, ctx.tenantId, scope, series, '')

  try {
    return await db.$transaction(async (tx) => {
      const t = tx as unknown as TenantPrismaClient

      const { correlativo } = await claimNextNumber(t, ctx.tenantId, scope, series)
      const fullNumber = formatFullNumber(series, correlativo)

      const doc = await t.taxDocument.create({
        data: {
          tenantId: ctx.tenantId,
          saleId: sale.id,
          documentType: input.documentType,
          series,
          correlativo,
          fullNumber,
          status: 'PENDIENTE',
          issuerTaxId: tenant.taxId,
          issuerLegalName: tenant.legalName ?? tenant.name,
          receiverDocType,
          receiverDocNumber,
          receiverName,
          receiverAddress,
          currency: sale.currency,
          subtotal: sale.subtotal,
          taxTotal: sale.taxTotal,
          discountTotal: sale.discountTotal,
          total: sale.total,
        },
        select: {
          id: true, documentType: true, series: true,
          correlativo: true, fullNumber: true, status: true, total: true,
        },
      })

      // El tipo del comprobante manda sobre el que se puso al cobrar: si se
      // cobró como NOTA_VENTA y luego el cliente pide factura, la venta debe
      // reflejar lo que realmente se emitió.
      await t.sale.update({
        where: { id: sale.id },
        data: { documentType: input.documentType },
      })

      await t.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorId: ctx.userId,
          actorRole: ctx.role,
          action: 'taxdocument.issue',
          entityType: 'TaxDocument',
          entityId: doc.id,
          after: {
            comprobante: fullNumber,
            tipo: input.documentType,
            venta: sale.number,
            total: num(sale.total),
          },
          impersonationId: ctx.impersonationId ?? null,
        },
      })

      return {
        id: doc.id,
        documentType: doc.documentType,
        series: doc.series,
        correlativo: doc.correlativo,
        fullNumber: doc.fullNumber,
        status: doc.status,
        total: num(doc.total),
        alreadyIssued: false,
      }
    }, {
      // Mismo motivo que en registerSale: el contador de correlativos
      // serializa, y con la base remota los 2 s por defecto no alcanzan
      // cuando varias cajas emiten a la vez.
      maxWait: 15_000,
      timeout: 30_000,
    })
  } catch (e) {
    // Carrera: dos cajeros emitiendo para la misma venta en el mismo
    // instante. El único de (tenantId, saleId) lo corta; se devuelve el que
    // ganó en vez de propagar un error que al cajero no le dice nada.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === P2002_UNIQUE) {
      const existente = await db.taxDocument.findFirst({
        where: { saleId: sale.id },
        select: {
          id: true, documentType: true, series: true,
          correlativo: true, fullNumber: true, status: true, total: true,
        },
      })
      if (existente) {
        return { ...existente, total: num(existente.total), alreadyIssued: true }
      }
    }
    throw e
  }
}

/**
 * Refleja la respuesta de la administración tributaria.
 *
 * Las transiciones se restringen: un comprobante ACEPTADO no vuelve a
 * PENDIENTE ni a RECHAZADO. Sin esa restricción, un reintento del proceso de
 * envío podría degradar el estado de un documento ya aceptado y dejar la
 * contabilidad diciendo que algo está pendiente cuando no lo está.
 */
export async function updateTaxStatus(
  db: TenantPrismaClient,
  ctx: TenantContext,
  input: UpdateTaxStatusInput,
): Promise<{ id: string; status: string }> {
  if (!hasRole(ctx.role, 'ADMIN')) {
    throw new BusinessError(
      'FORBIDDEN_ROLE',
      'Solo un administrador puede cambiar el estado tributario.',
    )
  }

  const doc = await db.taxDocument.findFirst({
    where: { id: input.taxDocumentId },
    select: { id: true, status: true, fullNumber: true },
  })

  if (!doc) {
    throw new BusinessError('TENANT_MISMATCH', 'El comprobante no existe.')
  }

  const PERMITIDO: Record<string, string[]> = {
    PENDIENTE: ['ENVIADO', 'ACEPTADO', 'RECHAZADO'],
    ENVIADO: ['ACEPTADO', 'RECHAZADO'],
    // Un rechazado se corrige y se reenvía.
    RECHAZADO: ['ENVIADO', 'ACEPTADO'],
    // Terminales.
    ACEPTADO: [],
    ANULADO: [],
  }

  if (!PERMITIDO[doc.status]?.includes(input.status)) {
    throw new BusinessError(
      'DUPLICATE_CODE',
      `No se puede pasar de ${doc.status} a ${input.status}.`,
    )
  }

  const ahora = new Date()
  const marca =
    input.status === 'ENVIADO' ? { sentAt: ahora }
    : input.status === 'ACEPTADO' ? { acceptedAt: ahora }
    : { rejectedAt: ahora }

  const [actualizado] = await db.$transaction([
    db.taxDocument.update({
      where: { id: doc.id },
      data: {
        status: input.status,
        statusMessage: input.statusMessage ?? null,
        externalTicket: input.externalTicket ?? undefined,
        responseCode: input.responseCode ?? undefined,
        ...marca,
      },
      select: { id: true, status: true },
    }),
    db.auditLog.create({
      data: {
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        actorRole: ctx.role,
        action: 'taxdocument.status',
        entityType: 'TaxDocument',
        entityId: doc.id,
        reason: input.statusMessage ?? null,
        before: { status: doc.status },
        after: { status: input.status, comprobante: doc.fullNumber },
      },
    }),
  ])

  return actualizado
}
