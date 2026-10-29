import type { Role, TaxDocumentStatus } from '@/generated/prisma/enums'
import { redondearCentimos } from '@/lib/dinero'
import { validarRuc } from '@/lib/documentos'
import { BusinessError } from '@/lib/errors'
import { diaLocal } from '@/lib/periodos'
import { montoALetras } from '@/lib/numero-a-letras'
import { exigir } from '@/lib/puede'
import type { TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { IDENTIDAD_SUNAT, UNIDAD_SUNAT, tipoComprobante } from './catalogos'
import { obtenerProveedor, ErrorConfiguracionProveedor } from './providers'
import { credencialesSunatDelNegocio } from '@/features/sunat/credenciales'
import { guardarArchivosFiscales } from '@/features/sunat/archivos'
import type {
  ComprobanteFiscal, CredencialesProveedor, LineaFiscal, ProveedorFacturacion,
} from './providers/types'
import { construirXmlUbl } from './ubl'
import { bloqueoDeEnvio, modoFiscal } from './modo-fiscal'
import { CODIGOS_NOTA_CREDITO_PARCIAL, documentoRelacionadoDe } from './notas'

export { NotaEsperaOriginal } from './notas'

/**
 * Envío de un comprobante al proveedor de facturación (hoy: SUNAT directo; el simulado para demos y pruebas).
 *
 * Camino: `TaxDocument` (PENDIENTE) → `ComprobanteFiscal` → XML UBL de
 * comprobación → proveedor → respuesta guardada en el mismo `TaxDocument`.
 *
 * ─── LO QUE NO SE HACE, A PROPÓSITO ──────────────────────────────────────
 *
 *  · Un negocio REAL nunca usa el proveedor simulado. Marcar «ACEPTADO» un
 *    comprobante que ningún OSE vio sería declarar a un cliente algo falso. Si
 *    no hay un proveedor real configurado, el envío se rechaza y el
 *    comprobante queda PENDIENTE, que es la verdad.
 *  · No se inventan credenciales. Las del proveedor y el certificado de cada
 *    negocio son de ese negocio y aún no hay dónde guardarlas cifradas (ver
 *    docs/COMPLIANCE.md); hasta entonces solo la demo y las pruebas envían.
 *  · No se guarda un hash propio como si fuera el de SUNAT: `xmlHash` es el
 *    que DEVUELVE el proveedor tras firmar.
 */

export interface ResultadoEnvio {
  estado: TaxDocumentStatus
  /** El proveedor falló de forma transitoria: se puede reintentar sin riesgo. */
  reintentable: boolean
  mensaje: string | null
  codigoRespuesta: string | null
}

/**
 * Quién envía. Un usuario (con permiso, ver `enviarComprobante`) o el SISTEMA (la cola): en ese caso
 * `id` y `role` son null, porque el worker no es ninguna persona y el AuditLog no puede apuntar a un
 * usuario que no existe.
 */
export interface ActorEnvio {
  tenantId: string
  id: string | null
  role: Role | null
  impersonationId?: string | null
  origen?: 'usuario' | 'cola'
}

export interface DependenciasEnvio {
  proveedor?: ProveedorFacturacion
  credenciales?: CredencialesProveedor
  ahora?: Date
  /** Solo pruebas: la URL del servicio de SUNAT a usar en lugar de la del ambiente (solo se acepta una de SUNAT o el SUNAT falso fuera de producción). */
  urlSunat?: string
}

const CREDENCIALES_DEMO: CredencialesProveedor = { usuario: 'mock:acepta', clave: 'demo', modoPruebas: true }

const cent = redondearCentimos

/** Arma el comprobante tal como se envía, a partir de lo CONGELADO al emitir y de la venta. */
export async function cargarComprobanteFiscal(
  db: TenantPrismaClient,
  taxDocumentId: string,
): Promise<{ comprobante: ComprobanteFiscal; doc: { id: string; status: TaxDocumentStatus; saleId: string; fullNumber: string; isTrial: boolean } }> {
  const doc = await db.taxDocument.findFirst({
    where: { id: taxDocumentId },
    select: {
      id: true, status: true, saleId: true, documentType: true, series: true, correlativo: true,
      fullNumber: true, issuedAt: true, currency: true, isTrial: true, total: true,
      // Solo las notas tienen estos campos; el comprobante original llega por la clave foránea compuesta (mismo negocio).
      reasonCode: true, reasonDescription: true,
      // Solo las notas PARCIALES (F6.2) tienen líneas propias; el resto deriva las suyas de la venta.
      items: { orderBy: { lineNo: 'asc' }, select: { description: true, sku: true, unitType: true, quantity: true, taxRate: true, subtotal: true, taxAmount: true, total: true } },
      relatedDocument: {
        select: { documentType: true, series: true, correlativo: true, status: true, isTrial: true, total: true, currency: true },
      },
      receiverDocType: true, receiverDocNumber: true, receiverName: true, receiverAddress: true,
      sale: {
        select: {
          // Forma de pago de la factura (#32): una venta fiada trae su cuenta por cobrar, con lo financiado y el vencimiento.
          receivable: { select: { amount: true, dueDate: true, status: true } },
          branch: { select: { establishmentCode: true, address: true, ubigeo: true } },
          items: {
            orderBy: { id: 'asc' },
            select: {
              nameSnapshot: true, skuSnapshot: true, quantity: true, lineTotal: true, taxRate: true,
              product: { select: { unitType: true } },
            },
          },
        },
      },
    },
  })
  if (!doc) throw new BusinessError('NOT_FOUND', 'El comprobante no existe.')

  const tipo = tipoComprobante(doc.documentType)
  if (!tipo) throw new BusinessError('INVALID_DOCUMENT', 'Este documento no es un comprobante electrónico.')

  // Nota de crédito/débito: se valida ANTES de armar nada (lanza `NotaEsperaOriginal` o un error permanente).
  const documentoRelacionado = tipo === '07' || tipo === '08'
    ? documentoRelacionadoDe({
        documentType: doc.documentType as 'NOTA_CREDITO' | 'NOTA_DEBITO',
        series: doc.series, isTrial: doc.isTrial, total: Number(doc.total), currency: doc.currency,
        reasonCode: doc.reasonCode, reasonDescription: doc.reasonDescription,
        relatedDocument: doc.relatedDocument && {
          ...doc.relatedDocument, total: Number(doc.relatedDocument.total),
        },
      })
    : undefined

  const tenant = await db.tenant.findFirstOrThrow({
    select: { taxId: true, legalName: true, name: true, address: true, ubigeo: true, timezone: true },
  })
  if (!tenant.taxId || !validarRuc(tenant.taxId).valido || !(tenant.legalName ?? tenant.name)) {
    throw new BusinessError(
      'INVALID_DOCUMENT',
      'Completa el RUC (válido) y la razón social del negocio antes de enviar comprobantes.',
    )
  }

  // Misma extracción de IGV que hizo la venta (por línea): Σ líneas == totales.
  const esParcial = CODIGOS_NOTA_CREDITO_PARCIAL.includes(doc.reasonCode ?? '')
  if (esParcial && doc.items.length === 0) throw new BusinessError('INVALID_DOCUMENT', 'La nota parcial no tiene líneas: no se puede enviar.')
  // Nota parcial: base e IGV ya vienen repartidos por línea (Σ líneas = total de la nota). Las demás: se extraen de cada línea de la venta.
  const fuente = esParcial
    ? doc.items.map((it) => ({ nombre: it.description, sku: it.sku, unitType: it.unitType, quantity: it.quantity, lineTotal: it.total, taxRate: it.taxRate, igv: Number(it.taxAmount) as number | null }))
    : doc.sale.items.map((it) => ({ nombre: it.nameSnapshot, sku: it.skuSnapshot, unitType: it.product.unitType, quantity: it.quantity, lineTotal: it.lineTotal, taxRate: it.taxRate, igv: null as number | null }))
  const lineas: LineaFiscal[] = fuente.map((it, i) => {
    const cantidad = Number(it.quantity)
    const neto = Number(it.lineTotal)
    const tasa = Number(it.taxRate)
    const base = it.igv === null ? cent(neto / (1 + tasa)) : cent(neto - it.igv)
    const igv = it.igv === null ? cent(neto - base) : it.igv
    return {
      numero: i + 1,
      descripcion: it.nombre,
      codigoProducto: it.sku,
      unidadMedida: UNIDAD_SUNAT[it.unitType],
      cantidad,
      precioUnitario: neto / cantidad,
      valorUnitario: base / cantidad,
      igv,
      tasaIgv: tasa,
      // ⚠️ El producto no guarda su afectación: 0 % se declara exonerado (20). Confirmar con el contador.
      tipoAfectacionIgv: tasa > 0 ? '10' : '20',
      importeTotal: neto,
      // El descuento ya está dentro del precio de la línea; no se informa aparte.
      descuento: 0,
    }
  })

  const suma = (f: (l: LineaFiscal) => number) => cent(lineas.reduce((s, l) => s + f(l), 0))
  const base = (l: LineaFiscal) => cent(l.importeTotal - l.igv)
  const totalGravado = suma((l) => (l.tipoAfectacionIgv === '10' ? base(l) : 0))
  const totalExonerado = suma((l) => (l.tipoAfectacionIgv === '20' ? base(l) : 0))
  const totalIgv = suma((l) => l.igv)
  const total = cent(totalGravado + totalExonerado + totalIgv)

  const comprobante: ComprobanteFiscal = {
    tipoComprobante: tipo,
    serie: doc.series,
    correlativo: doc.correlativo,
    fechaEmision: diaLocal(tenant.timezone, doc.issuedAt),
    moneda: doc.currency,
    emisor: {
      ruc: tenant.taxId,
      razonSocial: tenant.legalName ?? tenant.name,
      nombreComercial: tenant.name,
      direccion: doc.sale.branch.address ?? tenant.address,
      ubigeo: doc.sale.branch.ubigeo ?? tenant.ubigeo,
      codigoEstablecimiento: doc.sale.branch.establishmentCode,
    },
    receptor: {
      tipoDocumento: IDENTIDAD_SUNAT[doc.receiverDocType],
      numeroDocumento: doc.receiverDocNumber,
      razonSocial: doc.receiverName ?? 'CLIENTES VARIOS',
      direccion: doc.receiverAddress,
    },
    lineas,
    totalGravado, totalExonerado, totalInafecto: 0, totalIgv,
    totalDescuentos: 0,
    total,
    totalEnLetras: montoALetras(total, doc.currency),
    // Solo las facturas llevan forma de pago; la cuenta por cobrar anulada ya no financia nada.
    ...(tipo === '01' && doc.sale.receivable && doc.sale.receivable.status !== 'ANULADA'
      ? { formaPago: { tipo: 'Credito' as const, monto: Number(doc.sale.receivable.amount), vence: doc.sale.receivable.dueDate.toISOString().slice(0, 10) } }
      : {}),
    ...(documentoRelacionado ? { documentoRelacionado } : {}),
  }
  return { comprobante, doc: { id: doc.id, status: doc.status, saleId: doc.saleId, fullNumber: doc.fullNumber, isTrial: doc.isTrial } }
}

export async function elegirProveedor(
  db: TenantPrismaClient,
  tenantId: string,
  deps: DependenciasEnvio,
): Promise<{ proveedor: ProveedorFacturacion; credenciales: CredencialesProveedor }> {
  const t = await db.tenant.findFirstOrThrow({ select: { isDemo: true, realBillingEnabledAt: true, realBillingPausedAt: true } })
  if (t.isDemo) {
    return { proveedor: deps.proveedor ?? obtenerProveedor(undefined, { esDemo: true }), credenciales: deps.credenciales ?? CREDENCIALES_DEMO }
  }

  // Interruptor «facturación real»: apagado (por defecto), NADA sale hacia un proveedor,
  // ni siquiera con credenciales cargadas. Lo enciende un SuperAdmin tras validar el sandbox.
  const modo = modoFiscal(t)
  const bloqueo = bloqueoDeEnvio(modo)
  if (bloqueo) throw new BusinessError('INVALID_DOCUMENT', bloqueo)

  // Inyectado (solo pruebas): el proveedor y las credenciales vienen de fuera.
  if (deps.proveedor) {
    if (!deps.credenciales) {
      throw new BusinessError('INVALID_DOCUMENT', 'Faltan las credenciales del proveedor de facturación de este negocio.')
    }
    return { proveedor: deps.proveedor, credenciales: deps.credenciales }
  }

  // Lo normal: SUNAT directo, con las credenciales que el dueño cargó (descifradas aquí, en el servidor, y solo para este envío).
  const cred = await credencialesSunatDelNegocio(db, tenantId)
  if (!cred) {
    throw new BusinessError(
      'INVALID_DOCUMENT',
      'No hay credenciales de SUNAT cargadas (certificado digital y usuario SOL). El comprobante queda pendiente de envío.',
    )
  }
  // Los comprobantes REALES no se envían al ambiente de PRUEBAS de SUNAT: allí no tienen valor y quedarían "aceptados" aquí sin existir ante SUNAT.
  // Pasar a producción es del SuperAdmin (S5); mientras tanto el comprobante queda pendiente, que es la verdad.
  if (cred.ambiente !== 'PRODUCCION' && !deps.urlSunat) {
    throw new BusinessError(
      'INVALID_DOCUMENT',
      'La conexión con SUNAT está en el ambiente de PRUEBAS: los comprobantes reales quedan pendientes hasta que soporte active la producción.',
    )
  }
  return {
    proveedor: obtenerProveedor('sunat-directo'),
    credenciales: {
      usuario: '', clave: '', modoPruebas: cred.ambiente !== 'PRODUCCION', urlBase: deps.urlSunat ?? cred.urlBill,
      certificadoBase64: cred.pfx.toString('base64'), claveCertificado: cred.claveCertificado, usuarioSol: cred.usuarioSol, claveSol: cred.claveSol,
    },
  }
}

/** Un problema de configuración del proveedor no es un rechazo del comprobante: no cambia su estado. */
function comoError(e: unknown): never {
  if (e instanceof ErrorConfiguracionProveedor) throw new BusinessError('INVALID_DOCUMENT', e.message)
  throw e
}

export async function enviarInterno(
  db: TenantPrismaClient,
  actor: ActorEnvio,
  taxDocumentId: string,
  deps: DependenciasEnvio = {},
): Promise<ResultadoEnvio> {
  const ahora = deps.ahora ?? new Date()

  const { comprobante, doc } = await cargarComprobanteFiscal(db, taxDocumentId)
  // PRIMERO y antes de elegir proveedor: un documento de prueba no se envía nunca, en ningún modo.
  if (doc.isTrial) {
    throw new BusinessError(
      'INVALID_DOCUMENT',
      'Este es un documento de prueba, sin valor tributario: no se envía a ningún proveedor.',
    )
  }
  if (doc.status !== 'PENDIENTE') {
    throw new BusinessError(
      'INVALID_DOCUMENT',
      doc.status === 'RECHAZADO'
        ? 'El comprobante fue rechazado. Corrige el problema y emite uno nuevo, o anúlalo.'
        : `El comprobante ya está ${doc.status.toLowerCase()}.`,
    )
  }

  // Si los totales no cuadran, se corta AQUÍ y nada sale del sistema.
  construirXmlUbl(comprobante)

  const { proveedor, credenciales } = await elegirProveedor(db, actor.tenantId, deps)
  const r = await proveedor.emitir(comprobante, credenciales).catch(comoError)

  // Fallo transitorio: no cambia el estado. Reintentar es seguro porque el
  // proveedor es idempotente por (serie, correlativo).
  if (r.reintentable) {
    await db.taxDocument.update({ where: { id: doc.id }, data: { statusMessage: r.mensaje } })
    return { estado: 'PENDIENTE', reintentable: true, mensaje: r.mensaje, codigoRespuesta: r.codigoRespuesta }
  }

  await db.$transaction(async (tx) => {
    const t = tx as unknown as TenantPrismaClient
    const cambio = await t.taxDocument.updateMany({
      // Solo desde PENDIENTE: dos envíos simultáneos no se pisan.
      where: { id: doc.id, status: 'PENDIENTE' },
      data: {
        status: r.estado,
        statusMessage: r.mensaje,
        xmlHash: r.hashXml,
        externalTicket: r.ticket,
        externalId: r.idExterno,
        responseCode: r.codigoRespuesta,
        sentAt: ahora,
        acceptedAt: r.estado === 'ACEPTADO' || r.estado === 'OBSERVADO' ? ahora : null,
        rejectedAt: r.estado === 'RECHAZADO' ? ahora : null,
      },
    })
    if (cambio.count === 1) {
      // Lo que se envió y lo que SUNAT respondió, en la MISMA transacción que el cambio de estado: no puede quedar «aceptado» sin su constancia.
      await guardarArchivosFiscales(t, actor.tenantId, doc.id, r.archivos)
      await t.auditLog.create({
        data: {
          tenantId: actor.tenantId, actorId: actor.id, actorRole: actor.role,
          action: 'comprobante.enviar', entityType: 'TaxDocument', entityId: doc.id,
          before: { status: 'PENDIENTE' },
          after: { status: r.estado, proveedor: proveedor.nombre, codigo: r.codigoRespuesta, origen: actor.origen ?? 'usuario' },
          impersonationId: actor.impersonationId ?? null,
        },
      })
    }
  })

  return { estado: r.estado, reintentable: false, mensaje: r.mensaje, codigoRespuesta: r.codigoRespuesta }
}

/** Para un comprobante ENVIADO que espera respuesta (proveedores asíncronos). */
export async function consultarInterno(
  db: TenantPrismaClient,
  actor: ActorEnvio,
  taxDocumentId: string,
  deps: DependenciasEnvio = {},
): Promise<ResultadoEnvio> {
  const ahora = deps.ahora ?? new Date()

  const doc = await db.taxDocument.findFirst({
    where: { id: taxDocumentId },
    select: { id: true, status: true, series: true, correlativo: true, externalId: true, externalTicket: true, isTrial: true },
  })
  if (!doc) throw new BusinessError('NOT_FOUND', 'El comprobante no existe.')
  if (doc.isTrial) throw new BusinessError('INVALID_DOCUMENT', 'Este es un documento de prueba: no tiene estado ante ningún proveedor.')
  if (doc.status !== 'ENVIADO') {
    return { estado: doc.status, reintentable: false, mensaje: null, codigoRespuesta: null }
  }

  const { proveedor, credenciales } = await elegirProveedor(db, actor.tenantId, deps)
  const e = await proveedor.consultarEstado(
    { idExterno: doc.externalId, ticket: doc.externalTicket, serie: doc.series, correlativo: doc.correlativo },
    credenciales,
  ).catch(comoError)
  if (e.estado === 'ENVIADO') {
    return { estado: 'ENVIADO', reintentable: true, mensaje: e.mensaje, codigoRespuesta: e.codigoRespuesta }
  }

  await db.$transaction(async (tx) => {
    const t = tx as unknown as TenantPrismaClient
    const cambio = await t.taxDocument.updateMany({
      where: { id: doc.id, status: 'ENVIADO' },
      data: {
        status: e.estado,
        statusMessage: e.mensaje,
        responseCode: e.codigoRespuesta,
        ...(e.hashXml ? { xmlHash: e.hashXml } : {}),
        acceptedAt: e.estado === 'ACEPTADO' || e.estado === 'OBSERVADO' ? ahora : null,
        rejectedAt: e.estado === 'RECHAZADO' ? ahora : null,
      },
    })
    if (cambio.count === 1) {
      await guardarArchivosFiscales(t, actor.tenantId, doc.id, e.cdrXml ? { cdrXml: e.cdrXml } : undefined)
      await t.auditLog.create({
        data: {
          tenantId: actor.tenantId, actorId: actor.id, actorRole: actor.role,
          action: 'comprobante.respuesta', entityType: 'TaxDocument', entityId: doc.id,
          before: { status: 'ENVIADO' }, after: { status: e.estado, codigo: e.codigoRespuesta },
          impersonationId: actor.impersonationId ?? null,
        },
      })
    }
  })
  return { estado: e.estado, reintentable: false, mensaje: e.mensaje, codigoRespuesta: e.codigoRespuesta }
}


const actorDe = (ctx: TenantContext): ActorEnvio => ({
  tenantId: ctx.tenantId, id: ctx.userId, role: ctx.role, impersonationId: ctx.impersonationId ?? null, origen: 'usuario',
})

/** Envío pedido por una PERSONA: exige el permiso. El worker usa `enviarInterno`, que no lo necesita. */
export async function enviarComprobante(
  db: TenantPrismaClient, ctx: TenantContext, taxDocumentId: string, deps: DependenciasEnvio = {},
): Promise<ResultadoEnvio> {
  exigir(ctx, 'comprobantes.emitir')
  return enviarInterno(db, actorDe(ctx), taxDocumentId, deps)
}

/** Consulta de estado pedida por una persona. */
export async function refrescarEstado(
  db: TenantPrismaClient, ctx: TenantContext, taxDocumentId: string, deps: DependenciasEnvio = {},
): Promise<ResultadoEnvio> {
  exigir(ctx, 'comprobantes.emitir')
  return consultarInterno(db, actorDe(ctx), taxDocumentId, deps)
}
