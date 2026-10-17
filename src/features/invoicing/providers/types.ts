/**
 * Interfaz agnóstica del proveedor de facturación electrónica (PSE/OSE).
 *
 * ─── POR QUÉ ESTA CAPA ───────────────────────────────────────────────────
 *
 * Cada PSE tiene su propio formato: unos aceptan JSON propietario, otros
 * exigen el UBL ya armado; unos devuelven el CDR en la misma respuesta, otros
 * por webhook. Si el servicio de emisión hablara directamente con uno,
 * cambiar de proveedor —porque sube el precio, se cae o no cumple— sería
 * reescribir el módulo entero.
 *
 * Con esta interfaz, cambiar de proveedor es **un archivo nuevo**.
 *
 * ─── LO QUE NO HACE, Y ES DELIBERADO ─────────────────────────────────────
 *
 * No intenta ser un "estándar universal de facturación". Modela exactamente
 * las cinco operaciones que FerreSaaS necesita y nada más. Una abstracción
 * que intenta cubrir todo lo que cualquier PSE podría ofrecer acaba siendo el
 * mínimo común denominador de todos y no sirve para ninguno.
 */

import type { TaxDocumentStatus } from '@/generated/prisma/enums'

// ═══════════════════════════════════════════════════════════════════════════
//  LO QUE SE ENVÍA
// ═══════════════════════════════════════════════════════════════════════════

/** Emisor. Sale de `Tenant` + la sucursal que emite. */
export interface EmisorFiscal {
  ruc: string
  razonSocial: string
  nombreComercial: string | null
  direccion: string | null
  ubigeo: string | null
  /** Código de establecimiento anexo: "0000" la casa matriz. */
  codigoEstablecimiento: string
}

/** Receptor, congelado al emitir. */
export interface ReceptorFiscal {
  /** Catálogo 06 de SUNAT: 1=DNI, 6=RUC, 4=C.E., 7=Pasaporte, 0=sin documento. */
  tipoDocumento: '0' | '1' | '4' | '6' | '7'
  numeroDocumento: string | null
  razonSocial: string
  direccion: string | null
}

export interface LineaFiscal {
  /** Orden en el comprobante, desde 1. */
  numero: number
  descripcion: string
  codigoProducto: string
  /** Catálogo 03 de SUNAT: NIU unidad, KGM kilogramo, MTR metro… */
  unidadMedida: string
  cantidad: number
  /** Precio unitario CON IGV, que es como se muestra en Perú. */
  precioUnitario: number
  /** Base imponible de la línea (sin IGV). */
  valorUnitario: number
  igv: number
  tasaIgv: number
  /**
   * Catálogo 07 de SUNAT. "10" gravado, "20" exonerado, "30" inafecto.
   * Se deriva de la tasa, no se teclea.
   */
  tipoAfectacionIgv: string
  importeTotal: number
  descuento: number
}

export interface ComprobanteFiscal {
  /** Catálogo 01: "01" factura, "03" boleta, "07" nota de crédito. */
  tipoComprobante: '01' | '03' | '07'
  serie: string
  correlativo: number
  fechaEmision: string
  moneda: string
  emisor: EmisorFiscal
  receptor: ReceptorFiscal
  lineas: LineaFiscal[]
  /** Suma de bases de las líneas GRAVADAS. */
  totalGravado: number
  totalExonerado: number
  totalInafecto: number
  totalIgv: number
  totalDescuentos: number
  total: number
  /** Importe en letras: lo exige el Reglamento de Comprobantes de Pago. */
  totalEnLetras: string
  /** Para una nota de crédito: el comprobante que corrige. */
  documentoRelacionado?: {
    tipoComprobante: '01' | '03'
    serie: string
    correlativo: number
    /** Catálogo 09: motivo de la nota de crédito. */
    motivo: string
    descripcionMotivo: string
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  LO QUE SE RECIBE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Resultado de una operación contra el proveedor.
 *
 * `estado` se mapea a nuestro `TaxDocumentStatus`, que ya existía. Que los
 * nombres coincidan no es casualidad: la máquina de estados se diseñó pensando
 * en este ciclo (PENDIENTE → ENVIADO → ACEPTADO/RECHAZADO).
 */
export interface ResultadoEmision {
  estado: TaxDocumentStatus
  /**
   * Identificador del proveedor para este comprobante. Hay que GUARDARLO:
   * es lo único con lo que se puede consultar el estado más tarde o pedir el
   * XML, y si se pierde, el comprobante queda huérfano en su sistema.
   */
  idExterno: string | null
  /** Ticket asíncrono: algunos proveedores responden antes de tener el CDR. */
  ticket: string | null
  /** Código de respuesta de SUNAT. "0" es aceptado. */
  codigoRespuesta: string | null
  /** Mensaje legible. En un rechazo, el motivo que hay que mostrarle al usuario. */
  mensaje: string | null
  /** Hash del XML firmado. Es lo que va dentro del QR del comprobante. */
  hashXml: string | null
  /**
   * `true` si el rechazo es RECUPERABLE reintentando (caída de red, 503).
   * `false` si es un rechazo de fondo (RUC mal, correlativo duplicado):
   * reintentar eso solo gasta cupo y confunde los logs.
   */
  reintentable: boolean
}

export interface EstadoComprobante {
  estado: TaxDocumentStatus
  codigoRespuesta: string | null
  mensaje: string | null
  aceptadoEn: string | null
}

export type FormatoDescarga = 'XML' | 'CDR' | 'PDF'

export interface Descarga {
  formato: FormatoDescarga
  /** Contenido en base64. El XML firmado hay que conservarlo: es el original. */
  contenidoBase64: string
  nombreArchivo: string
  tipoMime: string
}

export interface ResultadoBaja {
  /** Ticket de la comunicación de baja: el resultado llega después. */
  ticket: string | null
  estado: TaxDocumentStatus
  mensaje: string | null
}

// ═══════════════════════════════════════════════════════════════════════════
//  CREDENCIALES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Credenciales POR TENANT. Nunca globales: cada ferretería emite bajo su
 * propio RUC con sus propias credenciales.
 *
 * ⚠️ Esto va CIFRADO en reposo cuando se implemente el almacén. Un
 * certificado o una Clave SOL en claro en la base es una fuga de identidad
 * tributaria, no una filtración de configuración.
 */
export interface CredencialesProveedor {
  /** Usuario/token que da el PSE. */
  usuario: string
  clave: string
  /** Certificado digital en base64 (.pfx/.p12), si el proveedor lo exige. */
  certificadoBase64?: string
  claveCertificado?: string
  /** Usuario SOL SECUNDARIO. Nunca el principal: ese da acceso total. */
  usuarioSol?: string
  claveSol?: string
  /** Para apuntar al entorno de pruebas del proveedor. */
  modoPruebas: boolean
}

// ═══════════════════════════════════════════════════════════════════════════
//  LA INTERFAZ
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Lo que debe implementar cada proveedor.
 *
 * Cinco operaciones. Añadir un proveedor es crear un archivo que exporte
 * esto; nada más del sistema cambia.
 */
export interface ProveedorFacturacion {
  /** Nombre para logs y para la UI. */
  readonly nombre: string

  /** Emite el comprobante. Debe ser IDEMPOTENTE por (serie, correlativo). */
  emitir(
    comprobante: ComprobanteFiscal,
    credenciales: CredencialesProveedor,
  ): Promise<ResultadoEmision>

  /** Consulta el estado de uno ya enviado. Para resolver los PENDIENTE/ENVIADO. */
  consultarEstado(
    referencia: { idExterno: string | null; ticket: string | null; serie: string; correlativo: number },
    credenciales: CredencialesProveedor,
  ): Promise<EstadoComprobante>

  /**
   * Anula: nota de crédito (boletas y facturas entregadas) o comunicación de
   * baja (facturas no entregadas, dentro del plazo). El proveedor decide cuál
   * según el tipo y la antigüedad; nosotros pasamos el motivo.
   */
  anular(
    referencia: { idExterno: string | null; serie: string; correlativo: number; tipoComprobante: '01' | '03' },
    motivo: string,
    credenciales: CredencialesProveedor,
  ): Promise<ResultadoBaja>

  /** Descarga el XML firmado, el CDR o el PDF. */
  descargar(
    referencia: { idExterno: string | null; serie: string; correlativo: number },
    formato: FormatoDescarga,
    credenciales: CredencialesProveedor,
  ): Promise<Descarga>

  /**
   * Comprueba que las credenciales sirven, SIN emitir nada.
   *
   * Existe para el onboarding: que el ferretero sepa que su certificado está
   * bien ANTES de su primera venta, en lugar de descubrirlo con un cliente
   * esperando en el mostrador.
   */
  verificarCredenciales(credenciales: CredencialesProveedor): Promise<{
    ok: boolean
    mensaje: string
    /** Vencimiento del certificado, si el proveedor lo informa. */
    certificadoVenceEn?: string
  }>
}
