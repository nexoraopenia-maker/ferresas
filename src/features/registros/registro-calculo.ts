import { ETIQUETA_DOCUMENTO_COMPRA, type TipoDocumentoCompra } from '@/features/compras/documento'

/**
 * Registro de ventas y registro de compras, como funciones PURAS sobre filas ya leídas. Todo en céntimos enteros.
 *
 * ─── REGISTRO DE VENTAS ──────────────────────────────────────────────────────────────────────────────────────────────────────
 * Sale de los comprobantes de venta (`TaxDocument`): facturas, boletas y notas de crédito/débito. Quedan FUERA los comprobantes de ENSAYO
 * (`isTrial`, sin valor tributario) y las notas de venta (no son comprobantes). Entran todos los estados, pero:
 *  · Los TOTALES suman solo los VÁLIDOS: ACEPTADO y OBSERVADO (observado = válido, con advertencias).
 *  · PENDIENTE, ENVIADO, RECHAZADO y ANULADO NO suman: van a un bloque de CONTROL aparte, con su conteo y su importe, para que no se olviden
 *    (un pendiente puede volverse válido; uno rechazado hay que corregirlo; uno anulado ya no vale).
 *  · Las notas de crédito RESTAN del total y las de débito suman: los importes salen con el signo con el que afectan.
 *
 * ─── REGISTRO DE COMPRAS ─────────────────────────────────────────────────────────────────────────────────────────────────────
 * Sale de las compras RECIBIDAS (las anuladas y los borradores no son compras). La fecha es la de EMISIÓN del documento del proveedor; si la
 * compra aún no tiene documento estructurado se usa la de RECEPCIÓN y la fila queda marcada PROVISIONAL (aviso para el contador). Las notas de
 * crédito de compra restan. Los totales suman todas las filas (provisionales incluidas); el bloque de control cuenta lo que falta completar.
 *
 * ⚠️ Estas reglas de qué estados suman y cómo se tratan las notas son una propuesta de producto pendiente de VALIDACIÓN del contador. No se
 * asignan códigos del catálogo oficial de SUNAT ni se genera formato PLE: eso es F5.6.
 */

const c = (n: number) => Math.round(n * 100)
const s = (cent: number) => cent / 100

// ─── Ventas ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export const ESTADOS_QUE_SUMAN = ['ACEPTADO', 'OBSERVADO'] as const
export const ESTADOS_DE_CONTROL = ['PENDIENTE', 'ENVIADO', 'RECHAZADO', 'ANULADO'] as const
export type EstadoComprobante = (typeof ESTADOS_QUE_SUMAN)[number] | (typeof ESTADOS_DE_CONTROL)[number]
export type TipoComprobante = 'FACTURA' | 'BOLETA' | 'NOTA_CREDITO' | 'NOTA_DEBITO'

export interface ComprobanteVenta {
  id: string
  /** Día del negocio (AAAA-MM-DD) en que se emitió. */
  fecha: string
  tipo: TipoComprobante
  /** «F001-00000123». */
  numero: string
  /** El comprobante que corrige una nota. */
  relacionado: string | null
  receptorTipo: string
  receptorNumero: string | null
  receptorNombre: string | null
  moneda: string
  /** Base imponible, IGV y total, en soles, TAL COMO están guardados (positivos también en las notas de crédito). */
  base: number
  igv: number
  total: number
  estado: EstadoComprobante
}

export interface FilaRegistroVentas extends ComprobanteVenta {
  /** +1 suma, −1 resta (nota de crédito). */
  signo: 1 | -1
  suma: boolean
  /** Algo que revisar de esta fila (factura sin RUC, moneda distinta…). */
  alertas: string[]
}

export interface Importes { base: number; igv: number; total: number }
export interface RegistroVentas {
  filas: FilaRegistroVentas[]
  /** Solo lo que suma (ACEPTADO y OBSERVADO), con las notas de crédito restando. */
  totales: Importes & { documentos: number }
  porTipo: { tipo: TipoComprobante; documentos: number; total: number }[]
  /** Lo que NO suma, por estado: para que no se olvide. */
  control: { estado: EstadoComprobante; documentos: number; total: number }[]
  /** Facturas cuyo receptor no tiene un RUC de 11 dígitos, y comprobantes en otra moneda. */
  alertas: { facturasSinRuc: number; otraMoneda: number }
}

const TIPOS_VENTA: TipoComprobante[] = ['FACTURA', 'BOLETA', 'NOTA_CREDITO', 'NOTA_DEBITO']
const suma = (e: EstadoComprobante) => (ESTADOS_QUE_SUMAN as readonly string[]).includes(e)
const signoDe = (t: TipoComprobante): 1 | -1 => (t === 'NOTA_CREDITO' ? -1 : 1)
const rucOk = (n: string | null) => !!n && /^\d{11}$/.test(n)

export function registroVentas(docs: readonly ComprobanteVenta[]): RegistroVentas {
  const filas = [...docs]
    .sort((x, y) => (x.fecha < y.fecha ? -1 : x.fecha > y.fecha ? 1 : x.numero < y.numero ? -1 : x.numero > y.numero ? 1 : x.id < y.id ? -1 : 1))
    .map((d): FilaRegistroVentas => {
      const alertas: string[] = []
      if (d.tipo === 'FACTURA' && !(d.receptorTipo === 'RUC' && rucOk(d.receptorNumero))) alertas.push('Factura sin RUC del cliente')
      if (d.moneda !== 'PEN') alertas.push(`Moneda ${d.moneda}`)
      return { ...d, signo: signoDe(d.tipo), suma: suma(d.estado), alertas }
    })
  let base = 0, igv = 0, total = 0, n = 0
  const tipos = new Map<TipoComprobante, { n: number; t: number }>(TIPOS_VENTA.map((t) => [t, { n: 0, t: 0 }]))
  const ctl = new Map<EstadoComprobante, { n: number; t: number }>(ESTADOS_DE_CONTROL.map((e) => [e, { n: 0, t: 0 }]))
  for (const f of filas) {
    if (f.suma) {
      base += f.signo * c(f.base); igv += f.signo * c(f.igv); total += f.signo * c(f.total); n++
      const t = tipos.get(f.tipo)!; t.n++; t.t += f.signo * c(f.total)
    } else {
      const k = ctl.get(f.estado)!; k.n++; k.t += f.signo * c(f.total)
    }
  }
  return {
    filas,
    totales: { base: s(base), igv: s(igv), total: s(total), documentos: n },
    porTipo: TIPOS_VENTA.map((tipo) => ({ tipo, documentos: tipos.get(tipo)!.n, total: s(tipos.get(tipo)!.t) })),
    control: ESTADOS_DE_CONTROL.map((estado) => ({ estado, documentos: ctl.get(estado)!.n, total: s(ctl.get(estado)!.t) })),
    alertas: { facturasSinRuc: filas.filter((f) => f.alertas.some((a) => a.startsWith('Factura'))).length, otraMoneda: filas.filter((f) => f.moneda !== 'PEN').length },
  }
}

// ─── Compras ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface CompraRegistrable {
  id: string
  /** Número interno («C001-00000007»). */
  compra: string
  /** Día de emisión del documento (AAAA-MM-DD) o `null` si la compra aún no lo tiene. */
  emision: string | null
  /** Día de recepción en la hora del negocio: la fecha provisional. */
  recepcion: string
  tipo: TipoDocumentoCompra | null
  serie: string | null
  numero: string | null
  /** Referencia libre de las compras anteriores. */
  referencia: string | null
  proveedorRuc: string | null
  proveedorNombre: string | null
  base: number
  igv: number
  total: number
  condicion: 'CONTADO' | 'CREDITO'
}

export interface FilaRegistroCompras extends CompraRegistrable {
  fecha: string
  provisional: boolean
  signo: 1 | -1
  documento: string
  tipoEtiqueta: string
  alertas: string[]
}

export interface RegistroCompras {
  filas: FilaRegistroCompras[]
  totales: Importes & { documentos: number }
  porTipo: { tipo: TipoDocumentoCompra | 'SIN_DOCUMENTO'; documentos: number; total: number }[]
  /** Lo que el contador debe completar antes de confiar en el registro. */
  control: { provisionales: number; sinProveedor: number; proveedorSinRuc: number; importeProvisional: number }
}

export function registroCompras(compras: readonly CompraRegistrable[]): RegistroCompras {
  const filas = compras.map((k): FilaRegistroCompras => {
    const provisional = k.emision === null
    const alertas: string[] = []
    if (provisional) alertas.push('Fecha provisional: falta el documento')
    if (!k.proveedorNombre) alertas.push('Sin proveedor')
    else if (!k.proveedorRuc || !/^\d{11}$/.test(k.proveedorRuc)) alertas.push('Proveedor sin RUC')
    return {
      ...k, fecha: k.emision ?? k.recepcion, provisional, signo: k.tipo === 'NOTA_CREDITO' ? -1 : 1,
      documento: k.serie && k.numero ? `${k.serie}-${k.numero}` : (k.referencia ?? ''),
      tipoEtiqueta: k.tipo ? ETIQUETA_DOCUMENTO_COMPRA[k.tipo] : 'Sin documento', alertas,
    }
  }).sort((x, y) => (x.fecha < y.fecha ? -1 : x.fecha > y.fecha ? 1 : x.documento < y.documento ? -1 : x.documento > y.documento ? 1 : x.id < y.id ? -1 : 1))
  let base = 0, igv = 0, total = 0, prov = 0
  const tipos = new Map<TipoDocumentoCompra | 'SIN_DOCUMENTO', { n: number; t: number }>()
  for (const f of filas) {
    base += f.signo * c(f.base); igv += f.signo * c(f.igv); total += f.signo * c(f.total)
    if (f.provisional) prov += f.signo * c(f.total)
    const k = f.tipo ?? 'SIN_DOCUMENTO'
    const a = tipos.get(k) ?? { n: 0, t: 0 }; a.n++; a.t += f.signo * c(f.total); tipos.set(k, a)
  }
  const orden = ['FACTURA', 'BOLETA', 'NOTA_CREDITO', 'NOTA_DEBITO', 'RECIBO_HONORARIOS', 'OTRO', 'SIN_DOCUMENTO'] as const
  return {
    filas,
    totales: { base: s(base), igv: s(igv), total: s(total), documentos: filas.length },
    porTipo: orden.filter((t) => tipos.has(t)).map((tipo) => ({ tipo, documentos: tipos.get(tipo)!.n, total: s(tipos.get(tipo)!.t) })),
    control: {
      provisionales: filas.filter((f) => f.provisional).length,
      sinProveedor: filas.filter((f) => !f.proveedorNombre).length,
      proveedorSinRuc: filas.filter((f) => f.proveedorNombre && !(f.proveedorRuc && /^\d{11}$/.test(f.proveedorRuc))).length,
      importeProvisional: s(prov),
    },
  }
}
