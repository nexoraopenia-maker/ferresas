import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { BusinessError } from '@/lib/errors'
import { montoALetras } from '@/lib/numero-a-letras'
import { redondearCentimos } from '@/lib/dinero'
import { diaLocal } from '@/lib/periodos'
import { IDENTIDAD_SUNAT, tipoComprobante } from '@/features/invoicing/catalogos'
import { construirTramaQr, llevaQr, qrSvg } from '@/features/invoicing/qr'

/** Qué se está imprimiendo. Define de dónde salen los datos. */
export type TipoImpresion = 'venta' | 'comprobante' | 'cotizacion'

export const TIPOS_IMPRESION: TipoImpresion[] = ['venta', 'comprobante', 'cotizacion']

export function esTipoImpresion(v: string): v is TipoImpresion {
  return (TIPOS_IMPRESION as string[]).includes(v)
}

export interface LineaImprimible {
  nombre: string
  sku: string
  cantidad: number
  unitType: string
  unitPrice: number
  descuento: number
  importe: number
  taxRate: number
}

export interface DocumentoImprimible {
  tipo: TipoImpresion
  /** Encabezado grande: "BOLETA DE VENTA ELECTRÓNICA". */
  titulo: string
  numero: string
  fecha: string

  /**
   * Zona horaria y locale del negocio. Sin esto el ticket se imprimiría con
   * la hora del servidor (UTC en Vercel) y una venta de las 9 p.m. en Lima
   * aparecería fechada al día siguiente.
   */
  zonaHoraria: string
  locale: string

  emisor: {
    nombre: string
    razonSocial: string | null
    ruc: string | null
    direccion: string | null
    telefono: string | null
  }

  cliente: {
    nombre: string
    docEtiqueta: string | null
    docNumero: string | null
    direccion: string | null
  } | null

  cajero: string
  almacen: string | null

  lineas: LineaImprimible[]

  moneda: string
  /** Base imponible de las líneas afectas a IGV. */
  opGravada: number
  /** Importe de las líneas con tasa 0. */
  opExonerada: number
  igv: number
  /** Tasa única si todas las líneas comparten una; `null` si hay mezcla. */
  tasaIgv: number | null
  descuento: number
  total: number
  totalEnLetras: string

  pagos: { metodo: string; monto: number; referencia: string | null; vuelto: number }[]
  recibido: number
  vuelto: number

  validUntil: string | null
  notas: string | null
  /** Estado tributario del comprobante, si aplica. */
  estadoTributario: string | null
  /** Hash (DigestValue) que devolvió el proveedor; solo de comprobantes aceptados. */
  hashXml: string | null
  /** QR reglamentario: solo con el hash real de un comprobante aceptado. */
  qr: { trama: string; svg: string } | null
  anulado: boolean
  /** Motivo de la anulación, para no imprimir un documento muerto en silencio. */
  motivoAnulacion: string | null
  /** Aviso a pie: una nota de venta o cotización NO es comprobante de pago. */
  avisoNoFiscal: string | null
  /** Marca de agua diagonal: COPIA, ANULADO, COTIZACIÓN… */
  marcaAgua: string | null
}

const num = (v: unknown): number => Number(v ?? 0)
/**
 * Cuantiza a céntimos. Usa el primitivo endurecido porque aquí sí entran
 * divisiones con decimales largos: extraer la base imponible de un importe
 * con IGV incluido es `importe / 1.18`.
 */
const cent = redondearCentimos

/**
 * Etiquetas de CustomerDocType. Las claves tienen que coincidir EXACTAMENTE
 * con el enum de Prisma: una clave mal escrita no falla, simplemente deja de
 * imprimir la línea del documento, y eso en una factura es un defecto legal.
 */
const DOC_ETIQUETA: Record<string, string> = {
  DNI: 'DNI',
  RUC: 'RUC',
  CE: 'C.E.',
  PASAPORTE: 'Pasaporte',
  SIN_DOCUMENTO: '',
}

/** Títulos fiscales. Solo los usa la impresión de un comprobante emitido. */
const TITULO: Record<string, string> = {
  BOLETA: 'BOLETA DE VENTA\nELECTRÓNICA',
  FACTURA: 'FACTURA\nELECTRÓNICA',
  NOTA_VENTA: 'NOTA DE VENTA',
  TICKET: 'TICKET',
}

const AVISO_NO_FISCAL =
  'Este documento no es un comprobante de pago válido para efectos ' +
  'tributarios. Solicite su boleta o factura.'

/** Pie de un documento de PRUEBA. No menciona «electrónico» ni SUNAT como si fuera uno. */
export const AVISO_PRUEBA =
  'DOCUMENTO DE PRUEBA, SIN VALOR TRIBUTARIO. No es una boleta ni una factura. ' +
  'Solicite su comprobante de pago.'

/**
 * Desglose de operaciones gravadas y exoneradas a partir de las líneas.
 *
 * Los precios en Perú ya incluyen IGV, así que la base se EXTRAE
 * (`base = neto / (1 + tasa)`); nunca se suma impuesto sobre el precio de
 * lista. Las líneas con tasa 0 son operaciones exoneradas y van en su propio
 * renglón: meterlas dentro de "OP. GRAVADA" declararía afecto algo que no lo
 * es.
 */
function desglosar(lineas: LineaImprimible[]) {
  let opGravada = 0
  let opExonerada = 0
  for (const l of lineas) {
    if (l.taxRate > 0) opGravada = cent(opGravada + l.importe / (1 + l.taxRate))
    else opExonerada = cent(opExonerada + l.importe)
  }
  const tasas = new Set(lineas.filter((l) => l.taxRate > 0).map((l) => l.taxRate))
  return {
    opGravada: cent(opGravada),
    opExonerada: cent(opExonerada),
    tasaIgv: tasas.size === 1 ? [...tasas][0]! : null,
  }
}

const SELECT_ITEMS = {
  nameSnapshot: true, skuSnapshot: true, unitType: true,
  quantity: true, unitPrice: true, discount: true, taxRate: true, lineTotal: true,
} as const

const SELECT_EMISOR = {
  name: true, legalName: true, taxId: true, address: true, phone: true,
  currency: true, timezone: true, locale: true,
} as const

function mapLineas(items: readonly {
  nameSnapshot: string; skuSnapshot: string; unitType: string
  quantity: unknown; unitPrice: unknown; discount: unknown; taxRate: unknown; lineTotal: unknown
}[]): LineaImprimible[] {
  return items.map((i) => ({
    nombre: i.nameSnapshot,
    sku: i.skuSnapshot,
    cantidad: num(i.quantity),
    unitType: i.unitType,
    unitPrice: num(i.unitPrice),
    descuento: num(i.discount),
    importe: num(i.lineTotal),
    taxRate: num(i.taxRate),
  }))
}

/**
 * Arma el documento imprimible, normalizando venta / comprobante /
 * cotización a una sola forma para que la plantilla térmica sea una.
 *
 * Todo sale del cliente con scope de tenant, así que un `id` de otro negocio
 * simplemente no existe: devuelve NOT_FOUND, no un documento ajeno.
 */
export async function getDocumentoImprimible(
  db: TenantPrismaClient,
  tipo: TipoImpresion,
  id: string,
): Promise<DocumentoImprimible> {
  const emisorRow = await db.tenant.findFirst({ select: SELECT_EMISOR })
  if (!emisorRow) throw new BusinessError('NOT_FOUND', 'No se encontró el negocio emisor.')

  const reloj = { zonaHoraria: emisorRow.timezone, locale: emisorRow.locale }
  const emisor = {
    nombre: emisorRow.name,
    razonSocial: emisorRow.legalName,
    ruc: emisorRow.taxId,
    direccion: emisorRow.address,
    telefono: emisorRow.phone,
  }

  if (tipo === 'cotizacion') return cotizacion(db, id, emisor, reloj)
  if (tipo === 'comprobante') return comprobante(db, id, emisor, reloj)
  return venta(db, id, emisor, reloj)
}

type Emisor = DocumentoImprimible['emisor']
type Reloj = { zonaHoraria: string; locale: string }

async function venta(db: TenantPrismaClient, id: string, emisor: Emisor, reloj: Reloj) {
  const sale = await db.sale.findFirst({
    where: { id },
    select: {
      number: true, documentType: true, status: true, currency: true,
      subtotal: true, taxTotal: true, discountTotal: true, total: true,
      notes: true, createdAt: true, completedAt: true,
      voidedAt: true, voidReason: true, soldBelowStock: true,
      items: { select: SELECT_ITEMS, orderBy: { createdAt: 'asc' } },
      payments: { select: { method: true, amount: true, reference: true, change: true } },
      user: { select: { name: true, email: true } },
      warehouse: { select: { name: true } },
      customer: { select: { name: true, docType: true, docNumber: true, address: true } },
      taxDocuments: { where: { documentType: { in: ['BOLETA', 'FACTURA'] } }, take: 1, select: { fullNumber: true } },
    },
  })
  if (!sale) throw new BusinessError('NOT_FOUND', 'La venta no existe.')

  const lineas = mapLineas(sale.items)
  const pagos = sale.payments.map((p) => ({
    metodo: p.method, monto: num(p.amount), referencia: p.reference, vuelto: num(p.change),
  }))
  const vuelto = cent(pagos.reduce((a, p) => a + p.vuelto, 0))
  const total = num(sale.total)

  // Si la venta ya tiene comprobante, el ticket es un documento interno: lo
  // dice en voz alta para que nadie lo entregue como si fuera la boleta.
  const conComprobante = sale.taxDocuments[0]?.fullNumber ?? null

  return {
    ...reloj,
    tipo: 'venta' as const,
    /*
     * SIEMPRE "NOTA DE VENTA", nunca el `documentType` de la venta.
     *
     * `issueTaxDocument` actualiza `Sale.documentType` a BOLETA o FACTURA al
     * emitir. Si el título se leyera de ahí, este ticket interno saldría
     * encabezado "BOLETA DE VENTA ELECTRÓNICA" pero rotulado con el número
     * de la VENTA (V001-…), no con el de la boleta (B001-…): un papel que
     * se anuncia como comprobante y lleva un número que no corresponde a
     * ningún comprobante. El título fiscal es exclusivo de la ruta
     * `comprobante`, que sí imprime el número y los importes declarados.
     */
    titulo: 'NOTA DE VENTA',
    numero: sale.number,
    fecha: (sale.completedAt ?? sale.createdAt).toISOString(),
    emisor,
    cliente: sale.customer ? mapCliente(sale.customer) : null,
    cajero: sale.user.name ?? sale.user.email,
    almacen: sale.warehouse.name,
    lineas,
    moneda: sale.currency,
    ...desglosar(lineas),
    igv: num(sale.taxTotal),
    descuento: num(sale.discountTotal),
    total,
    totalEnLetras: montoALetras(total, sale.currency),
    pagos,
    recibido: cent(pagos.reduce((a, p) => a + p.monto, 0)),
    vuelto,
    validUntil: null,
    notas: sale.notes,
    estadoTributario: null,
    hashXml: null,
    qr: null,
    anulado: sale.voidedAt !== null,
    motivoAnulacion: sale.voidReason,
    avisoNoFiscal: conComprobante
      ? `Esta venta ya tiene comprobante ${conComprobante}. Documento interno.`
      : AVISO_NO_FISCAL,
    marcaAgua: sale.voidedAt ? 'ANULADA' : null,
  }
}

async function comprobante(db: TenantPrismaClient, id: string, emisor: Emisor, reloj: Reloj) {
  const doc = await db.taxDocument.findFirst({
    where: { id },
    select: {
      documentType: true, fullNumber: true, status: true, statusMessage: true,
      series: true, correlativo: true, xmlHash: true, isTrial: true,
      issuerTaxId: true, issuerLegalName: true,
      receiverDocType: true, receiverDocNumber: true, receiverName: true, receiverAddress: true,
      currency: true, subtotal: true, taxTotal: true, discountTotal: true, total: true,
      issuedAt: true, voidedAt: true, voidReason: true,
      sale: {
        select: {
          number: true, notes: true,
          items: { select: SELECT_ITEMS, orderBy: { createdAt: 'asc' } },
          payments: { select: { method: true, amount: true, reference: true, change: true } },
          user: { select: { name: true, email: true } },
          warehouse: { select: { name: true } },
        },
      },
    },
  })
  if (!doc) throw new BusinessError('NOT_FOUND', 'El comprobante no existe.')
  // Pospuesto: la representación impresa de las notas aún no existe. Mejor un aviso claro que un ticket de boleta
  // con el número de una nota.
  if (doc.documentType === 'NOTA_CREDITO' || doc.documentType === 'NOTA_DEBITO') {
    throw new BusinessError('INVALID_DOCUMENT', 'La representación impresa de las notas de crédito y débito aún no está disponible.')
  }

  const lineas = mapLineas(doc.sale.items)
  const pagos = doc.sale.payments.map((p) => ({
    metodo: p.method, monto: num(p.amount), referencia: p.reference, vuelto: num(p.change),
  }))
  const total = num(doc.total)
  const { tasaIgv } = desglosar(lineas)

  const real = {
    ...reloj,
    tipo: 'comprobante' as const,
    titulo: TITULO[doc.documentType] ?? doc.documentType,
    numero: doc.fullNumber,
    fecha: doc.issuedAt.toISOString(),
    // El emisor congelado al emitir manda sobre el actual: si el negocio
    // corrigió su razón social después, el comprobante ya emitido conserva
    // la que llevaba impresa.
    emisor: {
      ...emisor,
      razonSocial: doc.issuerLegalName ?? emisor.razonSocial,
      ruc: doc.issuerTaxId ?? emisor.ruc,
    },
    cliente: doc.receiverName
      ? {
          nombre: doc.receiverName,
          docEtiqueta: DOC_ETIQUETA[doc.receiverDocType] || null,
          docNumero: doc.receiverDocNumber,
          direccion: doc.receiverAddress,
        }
      : null,
    cajero: doc.sale.user.name ?? doc.sale.user.email,
    almacen: doc.sale.warehouse.name,
    lineas,
    moneda: doc.currency,
    // Importes FROZEN del comprobante, no recalculados: lo impreso tiene que
    // coincidir con lo declarado, incluso si las líneas cambiaran.
    opGravada: num(doc.subtotal),
    opExonerada: 0,
    igv: num(doc.taxTotal),
    tasaIgv,
    descuento: num(doc.discountTotal),
    total,
    totalEnLetras: montoALetras(total, doc.currency),
    pagos,
    recibido: cent(pagos.reduce((a, p) => a + p.monto, 0)),
    vuelto: cent(pagos.reduce((a, p) => a + p.vuelto, 0)),
    validUntil: null,
    notas: doc.sale.notes,
    estadoTributario: doc.status,
    hashXml: llevaQr(doc.status, doc.xmlHash) ? doc.xmlHash : null,
    qr: await qrDelComprobante(doc, reloj.zonaHoraria),
    anulado: doc.voidedAt !== null,
    motivoAnulacion: doc.voidReason,
    avisoNoFiscal: null,
    marcaAgua: doc.voidedAt ? 'ANULADO' : null,
  }

  // Documento de PRUEBA (negocio que aún no habilitó la facturación real): NO debe parecerse a un
  // comprobante electrónico. Sin el pie «representación impresa del comprobante electrónico», sin QR,
  // sin «validación por SUNAT», con otro título y una marca de agua. Se imprime como documento interno.
  if (!doc.isTrial) return real
  return {
    ...real,
    tipo: 'venta' as const,
    titulo: 'DOCUMENTO DE PRUEBA',
    estadoTributario: null,
    hashXml: null,
    qr: null,
    avisoNoFiscal: AVISO_PRUEBA,
    marcaAgua: doc.voidedAt ? 'ANULADO' : 'PRUEBA',
  }
}

/** QR del comprobante, o `null` si todavía no hay un hash real que sostenerlo. */
async function qrDelComprobante(
  doc: {
    documentType: string; status: string; series: string; correlativo: number; xmlHash: string | null
    issuerTaxId: string | null; receiverDocType: keyof typeof IDENTIDAD_SUNAT; receiverDocNumber: string | null
    taxTotal: unknown; total: unknown; issuedAt: Date
  },
  zona: string,
): Promise<{ trama: string; svg: string } | null> {
  const tipo = tipoComprobante(doc.documentType as 'BOLETA')
  if (!tipo || !doc.issuerTaxId || !llevaQr(doc.status, doc.xmlHash)) return null
  const trama = construirTramaQr({
    ruc: doc.issuerTaxId, tipoComprobante: tipo, serie: doc.series, correlativo: doc.correlativo,
    igv: num(doc.taxTotal), total: num(doc.total), fecha: diaLocal(zona, doc.issuedAt),
    tipoDocCliente: IDENTIDAD_SUNAT[doc.receiverDocType], numDocCliente: doc.receiverDocNumber,
    hash: doc.xmlHash!,
  })
  return { trama, svg: await qrSvg(trama) }
}

async function cotizacion(db: TenantPrismaClient, id: string, emisor: Emisor, reloj: Reloj) {
  const quote = await db.quote.findFirst({
    where: { id },
    select: {
      number: true, status: true, currency: true,
      subtotal: true, taxTotal: true, discountTotal: true, total: true,
      validUntil: true, notes: true, createdAt: true,
      items: { select: SELECT_ITEMS, orderBy: { createdAt: 'asc' } },
      user: { select: { name: true, email: true } },
      warehouse: { select: { name: true } },
      customer: { select: { name: true, docType: true, docNumber: true, address: true } },
    },
  })
  if (!quote) throw new BusinessError('NOT_FOUND', 'La cotización no existe.')

  const lineas = mapLineas(quote.items)
  const total = num(quote.total)
  const vencida = quote.validUntil !== null && quote.validUntil.getTime() < Date.now()

  return {
    ...reloj,
    tipo: 'cotizacion' as const,
    titulo: 'COTIZACIÓN',
    numero: quote.number,
    fecha: quote.createdAt.toISOString(),
    emisor,
    cliente: quote.customer ? mapCliente(quote.customer) : null,
    cajero: quote.user.name ?? quote.user.email,
    almacen: quote.warehouse.name,
    lineas,
    moneda: quote.currency,
    ...desglosar(lineas),
    igv: num(quote.taxTotal),
    descuento: num(quote.discountTotal),
    total,
    totalEnLetras: montoALetras(total, quote.currency),
    pagos: [],
    recibido: 0,
    vuelto: 0,
    validUntil: quote.validUntil?.toISOString() ?? null,
    notas: quote.notes,
    estadoTributario: null,
    hashXml: null,
    qr: null,
    anulado: false,
    motivoAnulacion: null,
    avisoNoFiscal:
      'Cotización sin valor tributario. Los precios rigen hasta la fecha de ' +
      'validez indicada y están sujetos a disponibilidad de stock.',
    marcaAgua: vencida ? 'VENCIDA' : null,
  }
}

function mapCliente(c: {
  name: string; docType: string; docNumber: string | null; address: string | null
}) {
  return {
    nombre: c.name,
    docEtiqueta: DOC_ETIQUETA[c.docType] || null,
    docNumero: c.docNumber,
    direccion: c.address,
  }
}
