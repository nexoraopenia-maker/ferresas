import { Prisma } from '@/generated/prisma/client'
import { BusinessError } from '@/lib/errors'
import { validarRuc } from '@/lib/documentos'
import { type TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { claimNextNumber, ensureCounter } from '@/features/pos/sale-service'
import { exigirRequisitosFiscales } from './requisitos-fiscales'
import { modoFiscal, numeraEnPrueba } from './modo-fiscal'
import { encolarComprobante, seEncola } from '@/features/cola-fiscal/encolar'
import { cargarSucursalOperativa, serieDe } from '@/features/branches/queries'
import { scopeTributario } from '@/features/branches/series'
import {
  formatFullNumber,
  type IssueTaxDocumentInput,
  type UpdateTaxStatusInput,
} from './schemas'
import { puede } from '@/lib/puede'

const P2002_UNIQUE = 'P2002'

export interface IssuedDocument {
  id: string
  documentType: string
  series: string
  correlativo: number
  fullNumber: string
  status: string
  total: number
  /** Documento de PRUEBA (negocio en modo ensayo): serie PB001/PF001, sin valor tributario, nunca se envía. */
  isTrial: boolean
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
  if (!puede(ctx, 'comprobantes.emitir')) {
    throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para emitir comprobantes.')
  }

  // El modo fiscal decide la SERIE: un negocio que aún no habilitó la facturación real emite en
  // una serie de prueba y deja intacta la real (ver modo-fiscal.ts).
  const estado = await db.tenant.findFirstOrThrow({
    select: { isDemo: true, realBillingEnabledAt: true, realBillingPausedAt: true },
  })
  const modo = modoFiscal(estado)
  const prueba = numeraEnPrueba(modo)
  const scope = scopeTributario(input.documentType, prueba)

  const sale = await db.sale.findFirst({
    where: { id: input.saleId },
    select: {
      id: true,
      number: true,
      branchId: true,
      status: true,
      subtotal: true,
      taxTotal: true,
      discountTotal: true,
      total: true,
      currency: true,
      customer: {
        select: { docType: true, docNumber: true, name: true, address: true },
      },
      // El comprobante de venta (boleta o factura); las notas de crédito/débito de la venta no cuentan.
      taxDocuments: {
        where: { documentType: { in: ['BOLETA', 'FACTURA'] } },
        take: 1,
        select: {
          id: true, documentType: true, series: true, isTrial: true,
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
  const existente = sale.taxDocuments[0]
  if (existente) {
    const d = existente
    return {
      id: d.id,
      documentType: d.documentType,
      series: d.series,
      correlativo: d.correlativo,
      fullNumber: d.fullNumber,
      status: d.status,
      total: num(d.total),
      isTrial: d.isTrial,
      alreadyIssued: true,
    }
  }

  /*
   * La serie sale de la sucursal DE LA VENTA, no de la del usuario.
   *
   * Si un supervisor de la sucursal 2 emite la boleta de una venta hecha en
   * la sucursal 1, el comprobante tiene que llevar la serie del
   * establecimiento que vendió. Tomar la del usuario pondría ingresos de un
   * local en la numeración de otro.
   */
  // Con la facturación real habilitada, la sucursal tiene que estar completa (dirección y ubigeo).
  await exigirRequisitosFiscales(db, sale.branchId)

  const sucursal = await cargarSucursalOperativa(db, sale.branchId)
  const { series } = serieDe(sucursal, scope)

  /*
   * `input.series` ya no elige nada: la serie la determina la sucursal. Se
   * sigue aceptando en el esquema por compatibilidad, pero si no coincide se
   * RECHAZA en vez de ignorarse en silencio — ignorar una petición explícita
   * del cliente es cómo se emiten comprobantes con la serie equivocada sin
   * que nadie se entere.
   */
  if (input.series && input.series !== series) {
    throw new BusinessError(
      'INVALID_DOCUMENT',
      `La serie de esta venta es ${series}, la de su sucursal. No se puede emitir con ${input.series}.`,
      { esperada: series, recibida: input.series },
    )
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
    // Largo, prefijo y dígito verificador: un RUC mal tecleado lo rechazaría
    // SUNAT después, con el comprobante ya entregado al cliente.
    const rucOk = validarRuc(receiverDocNumber)
    if (!rucOk.valido) {
      throw new BusinessError('INVALID_DOCUMENT', `RUC del cliente: ${rucOk.mensaje}`)
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

  await ensureCounter(db, ctx.tenantId, sale.branchId, scope, series, '')

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
          isTrial: prueba,
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
          id: true, documentType: true, series: true, isTrial: true,
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

      // Cola de envío (outbox): el comprobante REAL y su fila nacen en la misma transacción. Un documento
      // de prueba no se encola nunca; la demo envía por su propio camino.
      if (seEncola({ isTrial: prueba }, modo)) await encolarComprobante(t, ctx.tenantId, doc.id)

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
            modo,
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
        isTrial: doc.isTrial,
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
          id: true, documentType: true, series: true, isTrial: true,
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
  /*
   * `comprobantes.estado_manual`, no `comprobantes.anular`. Son poderes
   * distintos que antes se confundían: anular es emitir una nota de crédito;
   * esto es DECLARAR a mano lo que respondió la administración tributaria.
   *
   * ⚠️ Mientras no exista el adaptador del PSE, este es el único camino para
   * reflejar un ACEPTADO. Cuando exista, pasar a ACEPTADO a mano debe exigir
   * el CDR o desaparecer: ver docs/COMPLIANCE.md.
   */
  if (!puede(ctx, 'comprobantes.estado_manual')) {
    throw new BusinessError(
      'FORBIDDEN_ROLE',
      'No tienes permiso para cambiar a mano el estado tributario.',
    )
  }

  const doc = await db.taxDocument.findFirst({
    where: { id: input.taxDocumentId },
    select: { id: true, status: true, statusMessage: true, fullNumber: true },
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
        // Si no hay mensaje del OSE, queda constancia visible en el listado de
        // que el cambio fue MANUAL y por qué.
        statusMessage: input.statusMessage ?? `Cambio manual: ${input.motivo}`,
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
        action: 'taxdocument.status.manual',
        entityType: 'TaxDocument',
        entityId: doc.id,
        // Motivo obligatorio: es lo que se consulta cuando se pregunta por qué
        // este comprobante figura con este estado.
        reason: input.motivo,
        // Estado ANTERIOR y NUEVO, y el mensaje que se sustituye.
        before: { status: doc.status, mensaje: doc.statusMessage ?? null },
        after: {
          status: input.status,
          comprobante: doc.fullNumber,
          mensaje: input.statusMessage ?? null,
          ticket: input.externalTicket ?? null,
          codigoRespuesta: input.responseCode ?? null,
        },
      },
    }),
  ])

  return actualizado
}
