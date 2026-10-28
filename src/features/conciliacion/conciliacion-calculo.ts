import type { ModoFiscal } from '@/features/invoicing/modo-fiscal'
import type { RegistroCompras, RegistroVentas } from '@/features/registros/registro-calculo'

/**
 * Conciliación fiscal: comprobaciones de coherencia entre ventas, comprobantes, numeración, cola de envío y compras, como funciones PURAS sobre
 * filas ya leídas. Todo en céntimos enteros. SOLO INFORMA: nada de aquí corrige datos; decide una persona.
 *
 * ─── PRINCIPIOS ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
 *  · Cada hallazgo tiene un NIVEL: ERROR (algo no cuadra o puede costar dinero/multa), ADVERTENCIA (hay que mirarlo) o INFO (explica una
 *    diferencia legítima). Un negocio sin nada que conciliar sale LIMPIO, sin alertas.
 *  · Un negocio en ENSAYO o DEMO no tiene comprobantes con valor fiscal: sus hallazgos nunca pasan de INFO. Los comprobantes de prueba
 *    (`isTrial`) no entran a ninguna comprobación real.
 *  · ⚠️ UMBRALES OPERATIVOS, NO NORMATIVOS: 24 h para advertir y 72 h para marcar error en lo pendiente de emitir o de enviar. No son plazos de
 *    SUNAT: son un criterio de trabajo aprobado por el dueño, pendiente de validar con el contador.
 */

/** ⚠️ Operativos, no normativos. */
export const UMBRAL_ADVERTENCIA_HORAS = 24
export const UMBRAL_ERROR_HORAS = 72
const MS_HORA = 3_600_000

export type Nivel = 'ERROR' | 'ADVERTENCIA' | 'INFO'
export const ORDEN_NIVEL: Record<Nivel, number> = { ERROR: 0, ADVERTENCIA: 1, INFO: 2 }

export const CODIGOS = [
  'PUENTE_NO_CUADRA', 'REGISTRO_VENTAS_NO_CUADRA', 'REGISTRO_COMPRAS_NO_CUADRA', 'VENTA_SIN_COMPROBANTE', 'COMPROBANTE_DISTINTO_A_VENTA',
  'COMPROBANTE_VIVO_EN_VENTA_CERRADA', 'FACTURA_SIN_RUC', 'COMPROBANTE_PENDIENTE', 'COMPROBANTE_RECHAZADO', 'ENVIO_AGOTADO', 'SERIE_CON_HUECOS',
  'CONTADOR_ATRASADO', 'CONTADOR_ADELANTADO', 'NOTA_EXCEDE_ORIGINAL', 'NOTA_DE_OTRA_VENTA', 'COMPRAS_PROVISIONALES', 'COMPRAS_PROVEEDOR_SIN_RUC',
  'COMPRAS_SIN_PROVEEDOR', 'DIFERENCIA_DE_FECHAS', 'COMPROBANTES_DE_VENTAS_DEVUELTAS', 'VENTAS_ANULADAS_O_DEVUELTAS', 'MODO_SIN_VALOR_FISCAL',
] as const
export type CodigoHallazgo = (typeof CODIGOS)[number]

const c = (n: number) => Math.round(n * 100)
const s = (cent: number) => cent / 100

export interface ItemHallazgo { referencia: string; detalle: string; importe: number | null; enlace: string | null }
export interface Hallazgo {
  codigo: CodigoHallazgo
  nivel: Nivel
  titulo: string
  explicacion: string
  cantidad: number
  /** Suma de los importes de los items (en soles), 0 si no aplican. */
  importe: number
  items: ItemHallazgo[]
}

const hallazgo = (codigo: CodigoHallazgo, nivel: Nivel, titulo: string, explicacion: string, items: ItemHallazgo[]): Hallazgo => ({
  codigo, nivel, titulo, explicacion, cantidad: items.length, importe: s(items.reduce((a, i) => a + (i.importe === null ? 0 : c(i.importe)), 0)), items,
})
const sinSuma = (codigo: CodigoHallazgo, nivel: Nivel, titulo: string, explicacion: string, cantidad: number, items: ItemHallazgo[] = []): Hallazgo =>
  ({ codigo, nivel, titulo, explicacion, cantidad, importe: 0, items })

/** ENSAYO y DEMO no tienen valor fiscal: nada pasa de INFO. */
export const sinValorFiscal = (m: ModoFiscal) => m === 'ENSAYO' || m === 'DEMO'
const tope = (nivel: Nivel, modo: ModoFiscal): Nivel => (sinValorFiscal(modo) ? 'INFO' : nivel)

/** Por antigüedad: menos de 24 h no es un hallazgo (es lo normal); 24 h o más advierte; 72 h o más es error. */
export function nivelPorAntiguedad(horas: number): Nivel | null {
  if (horas >= UMBRAL_ERROR_HORAS) return 'ERROR'
  if (horas >= UMBRAL_ADVERTENCIA_HORAS) return 'ADVERTENCIA'
  return null
}
const horasEntre = (desdeMs: number, ahoraMs: number) => Math.max(0, (ahoraMs - desdeMs) / MS_HORA)
const txtHoras = (h: number) => (h >= 48 ? `${Math.floor(h / 24)} días` : `${Math.floor(h)} h`)

// ─── Entradas ───────────────────────────────────────────────────────────────────────────────────────────────────────

export type EstadoDoc = 'PENDIENTE' | 'ENVIADO' | 'ACEPTADO' | 'OBSERVADO' | 'RECHAZADO' | 'ANULADO'
export type TipoDoc = 'BOLETA' | 'FACTURA' | 'NOTA_CREDITO' | 'NOTA_DEBITO'

export interface DocVenta {
  id: string
  tipo: TipoDoc
  numero: string
  estado: EstadoDoc
  isTrial: boolean
  base: number
  igv: number
  total: number
  receptorTipo: string
  receptorNumero: string | null
  /** Instante de emisión (ms). */
  emitidoMs: number
}

export interface VentaConc {
  id: string
  numero: string
  /** Lo que se pidió al vender (NOTA_VENTA, BOLETA, FACTURA…). */
  pide: string
  total: number
  base: number
  igv: number
  completadaMs: number
  /** El comprobante principal (boleta o factura) de la venta, si ya se emitió. */
  doc: DocVenta | null
}

const VALIDOS: readonly EstadoDoc[] = ['ACEPTADO', 'OBSERVADO']

// ─── Puente ventas → comprobantes ───────────────────────────────────────────────────────────────────────────────────

export interface LineaPuente { documentos: number; total: number }
export interface PuenteVentas {
  ventasCompletadas: LineaPuente
  /** Ventas sin comprobante por diseño (notas de venta). */
  notasDeVenta: LineaPuente
  /** Ventas con comprobante emitido o pedido (boleta/factura). */
  conComprobante: LineaPuente
  clasificacion: Record<'valido' | 'pendiente' | 'rechazado' | 'anulado' | 'ensayo' | 'sinComprobante', LineaPuente>
  /** `conComprobante` menos la suma de la clasificación: TIENE que ser cero. */
  diferencia: number
  /** Anuladas y devueltas del periodo: no suman en ventas completadas. */
  anuladas: LineaPuente
  devueltas: LineaPuente
}

export const ETIQUETA_PUENTE = { valido: 'Con comprobante aceptado u observado', pendiente: 'Con comprobante pendiente o enviado', rechazado: 'Con comprobante rechazado', anulado: 'Con comprobante anulado', ensayo: 'Con comprobante de ensayo', sinComprobante: 'Piden comprobante y no lo tienen' } as const

const cero = (): { n: number; t: number } => ({ n: 0, t: 0 })
const linea = (a: { n: number; t: number }): LineaPuente => ({ documentos: a.n, total: s(a.t) })

export function puenteVentas(ventas: readonly VentaConc[], anuladas: LineaPuente, devueltas: LineaPuente): PuenteVentas {
  const total = cero(), nv = cero(), con = cero()
  const k = { valido: cero(), pendiente: cero(), rechazado: cero(), anulado: cero(), ensayo: cero(), sinComprobante: cero() }
  const suma = (a: { n: number; t: number }, t: number) => { a.n++; a.t += t }
  for (const v of ventas) {
    const t = c(v.total)
    suma(total, t)
    if (v.doc) {
      suma(con, t)
      const d = v.doc
      if (d.isTrial) suma(k.ensayo, t)
      else if (VALIDOS.includes(d.estado)) suma(k.valido, t)
      else if (d.estado === 'PENDIENTE' || d.estado === 'ENVIADO') suma(k.pendiente, t)
      else if (d.estado === 'RECHAZADO') suma(k.rechazado, t)
      else suma(k.anulado, t)
    } else if (v.pide === 'BOLETA' || v.pide === 'FACTURA') {
      suma(con, t); suma(k.sinComprobante, t)
    } else suma(nv, t)
  }
  const clasificado = k.valido.t + k.pendiente.t + k.rechazado.t + k.anulado.t + k.ensayo.t + k.sinComprobante.t
  return {
    ventasCompletadas: linea(total), notasDeVenta: linea(nv), conComprobante: linea(con),
    clasificacion: { valido: linea(k.valido), pendiente: linea(k.pendiente), rechazado: linea(k.rechazado), anulado: linea(k.anulado), ensayo: linea(k.ensayo), sinComprobante: linea(k.sinComprobante) },
    diferencia: s(con.t - clasificado), anuladas, devueltas,
  }
}

// ─── Comprobaciones por venta ───────────────────────────────────────────────────────────────────────────────────────

export function hallazgosDeVentas(ventas: readonly VentaConc[], ahoraMs: number, modo: ModoFiscal, enlaceVenta: (id: string) => string | null = () => '/comprobantes'): Hallazgo[] {
  const out: Hallazgo[] = []
  // Ventas que piden boleta/factura y no tienen comprobante: por antigüedad.
  const sin = ventas.filter((v) => !v.doc && (v.pide === 'BOLETA' || v.pide === 'FACTURA'))
  const porNivel = new Map<Nivel, ItemHallazgo[]>()
  for (const v of sin) {
    const h = horasEntre(v.completadaMs, ahoraMs)
    const n = nivelPorAntiguedad(h)
    if (!n) continue
    const nivel = tope(n, modo)
    const a = porNivel.get(nivel) ?? []
    a.push({ referencia: v.numero, detalle: `Pidió ${v.pide === 'FACTURA' ? 'factura' : 'boleta'} y lleva ${txtHoras(h)} sin comprobante`, importe: v.total, enlace: enlaceVenta(v.id) })
    porNivel.set(nivel, a)
  }
  for (const nivel of ['ERROR', 'ADVERTENCIA', 'INFO'] as const) {
    const items = porNivel.get(nivel)
    if (!items?.length) continue
    out.push(hallazgo('VENTA_SIN_COMPROBANTE', nivel, 'Ventas que piden boleta o factura y no tienen comprobante',
      sinValorFiscal(modo) ? 'Tu negocio está en modo ensayo: los comprobantes son de prueba y no tienen valor fiscal, por eso esto es solo informativo.'
        : `Emítelos desde la venta. ⚠️ Umbrales operativos: ${UMBRAL_ADVERTENCIA_HORAS} h advierte y ${UMBRAL_ERROR_HORAS} h es error (no son plazos de SUNAT).`, items))
  }
  // El comprobante tiene que decir lo mismo que su venta (se copia al emitir: cualquier diferencia es un dato alterado).
  const dist: ItemHallazgo[] = []
  for (const v of ventas) {
    const d = v.doc
    if (!d || d.isTrial) continue
    if (c(d.total) !== c(v.total) || c(d.base) !== c(v.base) || c(d.igv) !== c(v.igv)) {
      dist.push({ referencia: d.numero, detalle: `La venta ${v.numero} dice base ${v.base.toFixed(2)} + IGV ${v.igv.toFixed(2)} = ${v.total.toFixed(2)}; el comprobante dice ${d.base.toFixed(2)} + ${d.igv.toFixed(2)} = ${d.total.toFixed(2)}`, importe: s(c(d.total) - c(v.total)), enlace: enlaceVenta(v.id) })
    }
  }
  if (dist.length) out.push(hallazgo('COMPROBANTE_DISTINTO_A_VENTA', tope('ERROR', modo), 'Comprobantes con importes distintos a los de su venta', 'Al emitir, el comprobante copia los importes de la venta. Una diferencia indica un dato modificado después. El importe mostrado es la diferencia (comprobante − venta).', dist))
  // Facturas sin un RUC de 11 dígitos.
  const sinRuc: ItemHallazgo[] = []
  for (const v of ventas) {
    const d = v.doc
    if (d && !d.isTrial && d.tipo === 'FACTURA' && !(d.receptorTipo === 'RUC' && /^\d{11}$/.test(d.receptorNumero ?? ''))) sinRuc.push({ referencia: d.numero, detalle: 'La factura no tiene un RUC de 11 dígitos', importe: d.total, enlace: enlaceVenta(v.id) })
  }
  if (sinRuc.length) out.push(hallazgo('FACTURA_SIN_RUC', tope('ADVERTENCIA', modo), 'Facturas sin RUC válido del cliente', 'Una factura exige el RUC del cliente. Revisa con tu contador cómo corregirla.', sinRuc))
  return out
}

// ─── Ventas anuladas o devueltas que conservan un comprobante vivo ──────────────────────────────────────────────────

export interface VentaCerrada {
  id: string
  numero: string
  estado: 'ANULADA' | 'DEVUELTA'
  doc: { numero: string; estado: EstadoDoc; total: number; notas: { tipo: TipoDoc; estado: EstadoDoc; total: number; motivoTotal: boolean }[] }
}

/**
 * Un comprobante está NEUTRALIZADO si tiene una nota de crédito TOTAL no rechazada, o notas de crédito no rechazadas que suman al menos su total.
 * Un comprobante rechazado o anulado ya no vale: no está «vivo».
 */
export function estaNeutralizado(doc: VentaCerrada['doc']): boolean {
  const ncs = doc.notas.filter((n) => n.tipo === 'NOTA_CREDITO' && n.estado !== 'RECHAZADO')
  return ncs.some((n) => n.motivoTotal) || ncs.reduce((a, n) => a + c(n.total), 0) >= c(doc.total)
}

export function hallazgosVentasCerradas(ventas: readonly VentaCerrada[], modo: ModoFiscal, enlaceVenta: (id: string) => string | null = () => '/comprobantes'): Hallazgo[] {
  const vivos = ventas.filter((v) => v.doc.estado !== 'RECHAZADO' && v.doc.estado !== 'ANULADO' && !estaNeutralizado(v.doc))
  if (!vivos.length) return []
  return [hallazgo('COMPROBANTE_VIVO_EN_VENTA_CERRADA', tope('ERROR', modo), 'Ventas anuladas o devueltas con un comprobante vivo sin nota de crédito',
    'El comprobante sigue vigente ante SUNAT aunque la venta ya no cuenta. Hace falta su nota de crédito que lo neutralice.',
    vivos.map((v) => ({ referencia: v.doc.numero, detalle: `La venta ${v.numero} está ${v.estado === 'ANULADA' ? 'anulada' : 'devuelta'} y el comprobante (${v.doc.estado.toLowerCase()}) no tiene nota de crédito`, importe: v.doc.total, enlace: enlaceVenta(v.id) })))]
}

// ─── Estado y cola de envío ─────────────────────────────────────────────────────────────────────────────────────────

export interface DocAbierto { id: string; numero: string; estado: 'PENDIENTE' | 'ENVIADO' | 'RECHAZADO'; total: number; emitidoMs: number }
export interface EnvioAgotado { numero: string; intentos: number; ultimoError: string | null }

export function hallazgosDeEnvio(docs: readonly DocAbierto[], agotados: readonly EnvioAgotado[], ahoraMs: number, modo: ModoFiscal): Hallazgo[] {
  const out: Hallazgo[] = []
  const porNivel = new Map<Nivel, ItemHallazgo[]>()
  for (const d of docs.filter((x) => x.estado !== 'RECHAZADO')) {
    const h = horasEntre(d.emitidoMs, ahoraMs)
    let n = nivelPorAntiguedad(h)
    if (!n) continue
    // Con el envío en pausa lo PENDIENTE espera por decisión del dueño: se explica, no se alarma. Lo ENVIADO sin respuesta sí es raro.
    if (modo === 'PAUSADO' && d.estado === 'PENDIENTE') n = 'INFO'
    const nivel = tope(n, modo)
    const a = porNivel.get(nivel) ?? []
    a.push({ referencia: d.numero, detalle: `${d.estado === 'PENDIENTE' ? 'Pendiente de envío' : 'Enviado sin respuesta'} hace ${txtHoras(h)}`, importe: d.total, enlace: null })
    porNivel.set(nivel, a)
  }
  for (const nivel of ['ERROR', 'ADVERTENCIA', 'INFO'] as const) {
    const items = porNivel.get(nivel)
    if (items?.length) out.push(hallazgo('COMPROBANTE_PENDIENTE', nivel, 'Comprobantes sin respuesta de SUNAT',
      `${modo === 'PAUSADO' ? 'El envío está en pausa: los pendientes esperan a que lo reanudes. ' : ''}⚠️ Umbrales operativos: ${UMBRAL_ADVERTENCIA_HORAS} h advierte y ${UMBRAL_ERROR_HORAS} h es error (no son plazos de SUNAT).`, items))
  }
  const rech = docs.filter((d) => d.estado === 'RECHAZADO')
  if (rech.length) out.push(hallazgo('COMPROBANTE_RECHAZADO', tope('ADVERTENCIA', modo), 'Comprobantes rechazados', 'SUNAT los rechazó: requieren corrección manual. Pueden haberse resuelto con otro comprobante; revísalos.',
    rech.map((d) => ({ referencia: d.numero, detalle: 'Rechazado', importe: d.total, enlace: null }))))
  if (agotados.length) out.push(hallazgo('ENVIO_AGOTADO', tope('ERROR', modo), 'Envíos que agotaron sus reintentos', 'El sistema dejó de intentarlo sin respuesta del proveedor: el comprobante sigue pendiente y necesita atención.',
    agotados.map((a) => ({ referencia: a.numero, detalle: `${a.intentos} intentos${a.ultimoError ? ` · último error: ${a.ultimoError.slice(0, 120)}` : ''}`, importe: null, enlace: null }))))
  return out
}

// ─── Numeración ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SerieConc {
  tipo: TipoDoc
  serie: string
  emitidos: number
  min: number
  max: number
  /** Los correlativos emitidos (solo hace falta cuando hay huecos). */
  correlativos: readonly number[] | null
  /** Contador de la serie, si existe: próximo número y arranque. */
  contador: { next: number; startNumber: number } | null
}

/** Los números que faltan entre el arranque (o el primero emitido) y el último. Tope de lo que se enumera: `limite`. */
export function huecosDeSerie(inicio: number, max: number, correlativos: readonly number[], limite = 50): { faltan: number; ejemplos: number[] } {
  const hay = new Set(correlativos)
  const ejemplos: number[] = []
  let faltan = 0
  for (let n = inicio; n <= max; n++) if (!hay.has(n)) { faltan++; if (ejemplos.length < limite) ejemplos.push(n) }
  return { faltan, ejemplos }
}

const fmt = (serie: string, n: number) => `${serie}-${String(n).padStart(8, '0')}`

/** El contador de numeración que corresponde a una serie (las notas de crédito tienen el suyo; las de débito no se emiten todavía). */
export function scopeDeSerie(tipo: TipoDoc, serie: string): string | null {
  if (tipo === 'FACTURA') return 'TAX_FACTURA'
  if (tipo === 'BOLETA') return 'TAX_BOLETA'
  if (tipo === 'NOTA_CREDITO') return serie.startsWith('F') ? 'TAX_NC_FACTURA' : 'TAX_NC_BOLETA'
  return null
}

export function inicioEsperado(s: SerieConc): number { return s.contador ? Math.min(s.contador.startNumber, s.min) : s.min }

/** ¿Esta serie necesita mirar los números uno por uno? (hay menos emitidos de los que cabrían entre el arranque y el último) */
export function serieSospechosa(s: SerieConc): boolean { return s.emitidos !== s.max - inicioEsperado(s) + 1 }

export function hallazgosDeNumeracion(series: readonly SerieConc[], modo: ModoFiscal): Hallazgo[] {
  const huecos: ItemHallazgo[] = [], atrasados: ItemHallazgo[] = [], adelantados: ItemHallazgo[] = []
  for (const sr of series) {
    if (sr.emitidos === 0) continue
    if (serieSospechosa(sr)) {
      const r = huecosDeSerie(inicioEsperado(sr), sr.max, sr.correlativos ?? [])
      if (r.faltan > 0) huecos.push({ referencia: sr.serie, detalle: `Faltan ${r.faltan} número${r.faltan === 1 ? '' : 's'}: ${r.ejemplos.map((n) => fmt(sr.serie, n)).slice(0, 5).join(', ')}${r.faltan > 5 ? '…' : ''}`, importe: null, enlace: null })
    }
    if (sr.contador) {
      if (sr.contador.next <= sr.max) atrasados.push({ referencia: sr.serie, detalle: `El contador va a emitir el ${fmt(sr.serie, sr.contador.next)} pero ya se emitió hasta el ${fmt(sr.serie, sr.max)}`, importe: null, enlace: null })
      else if (sr.contador.next > sr.max + 1) adelantados.push({ referencia: sr.serie, detalle: `El contador va por el ${fmt(sr.serie, sr.contador.next)} pero lo último emitido es el ${fmt(sr.serie, sr.max)}: se saltó números`, importe: null, enlace: null })
    }
  }
  const out: Hallazgo[] = []
  if (huecos.length) out.push(hallazgo('SERIE_CON_HUECOS', tope('ERROR', modo), 'Series con números saltados', 'Una serie con huecos es una contingencia tributaria: cada número emitido debe existir. Un hueco puede ser un comprobante que se perdió.', huecos))
  if (atrasados.length) out.push(hallazgo('CONTADOR_ATRASADO', tope('ERROR', modo), 'Contadores por detrás del último comprobante', 'El próximo comprobante repetiría un número ya emitido.', atrasados))
  if (adelantados.length) out.push(hallazgo('CONTADOR_ADELANTADO', tope('ADVERTENCIA', modo), 'Contadores por delante del último comprobante', 'Se saltaron números: el siguiente comprobante dejará un hueco.', adelantados))
  return out
}

// ─── Notas de crédito ───────────────────────────────────────────────────────────────────────────────────────────────

export interface NotaConc {
  numero: string
  tipo: 'NOTA_CREDITO' | 'NOTA_DEBITO'
  estado: EstadoDoc
  total: number
  saleId: string
  original: { numero: string; total: number; saleId: string; notasCredito: { estado: EstadoDoc; total: number }[] }
}

export function hallazgosDeNotas(notas: readonly NotaConc[], modo: ModoFiscal): Hallazgo[] {
  const vistos = new Set<string>()
  const exceden: ItemHallazgo[] = [], otraVenta: ItemHallazgo[] = []
  for (const n of notas) {
    if (n.estado === 'RECHAZADO') continue
    if (n.saleId !== n.original.saleId) otraVenta.push({ referencia: n.numero, detalle: `Corrige ${n.original.numero}, que es de otra venta`, importe: n.total, enlace: null })
    if (n.tipo !== 'NOTA_CREDITO' || vistos.has(n.original.numero)) continue
    const suma = n.original.notasCredito.filter((x) => x.estado !== 'RECHAZADO').reduce((a, x) => a + c(x.total), 0)
    if (suma > c(n.original.total)) {
      vistos.add(n.original.numero)
      exceden.push({ referencia: n.original.numero, detalle: `Sus notas de crédito suman ${s(suma).toFixed(2)} y el comprobante es de ${n.original.total.toFixed(2)}`, importe: s(suma - c(n.original.total)), enlace: null })
    }
  }
  const out: Hallazgo[] = []
  if (exceden.length) out.push(hallazgo('NOTA_EXCEDE_ORIGINAL', tope('ERROR', modo), 'Notas de crédito que suman más que su comprobante', 'No se puede devolver más de lo que se facturó. El importe es el exceso.', exceden))
  if (otraVenta.length) out.push(hallazgo('NOTA_DE_OTRA_VENTA', tope('ERROR', modo), 'Notas que apuntan a un comprobante de otra venta', 'Una nota siempre pertenece a la venta de su comprobante.', otraVenta))
  return out
}

// ─── Cuadre con los registros ───────────────────────────────────────────────────────────────────────────────────────

export interface AgregadoDoc { tipo: TipoDoc; estado: EstadoDoc; documentos: number; base: number; igv: number; total: number }

/** El total del registro de ventas calculado SIN pasar por él: desde agregados de la base. Suman aceptados y observados; la NC resta. */
export function totalDesdeAgregados(grupos: readonly AgregadoDoc[]): { base: number; igv: number; total: number; documentos: number } {
  let b = 0, i = 0, t = 0, n = 0
  for (const g of grupos) {
    if (!VALIDOS.includes(g.estado)) continue
    const sg = g.tipo === 'NOTA_CREDITO' ? -1 : 1
    b += sg * c(g.base); i += sg * c(g.igv); t += sg * c(g.total); n += g.documentos
  }
  return { base: s(b), igv: s(i), total: s(t), documentos: n }
}

export interface CuadreRegistro { registro: number; independiente: number; diferencia: number }

export function cuadre(registro: number, independiente: number): CuadreRegistro {
  return { registro, independiente, diferencia: s(c(registro) - c(independiente)) }
}

export function hallazgoDeCuadre(codigo: 'REGISTRO_VENTAS_NO_CUADRA' | 'REGISTRO_COMPRAS_NO_CUADRA', q: CuadreRegistro, modo: ModoFiscal): Hallazgo | null {
  if (q.diferencia === 0) return null
  return hallazgo(codigo, tope('ERROR', modo), codigo === 'REGISTRO_VENTAS_NO_CUADRA' ? 'El registro de ventas no cuadra con los comprobantes' : 'El registro de compras no cuadra con las compras',
    `El registro suma ${q.registro.toFixed(2)} y el cálculo independiente desde la base da ${q.independiente.toFixed(2)}. Una de las dos rutas está mal: avisa a soporte.`,
    [{ referencia: codigo === 'REGISTRO_VENTAS_NO_CUADRA' ? 'Registro de ventas' : 'Registro de compras', detalle: `Diferencia ${q.diferencia.toFixed(2)}`, importe: q.diferencia, enlace: null }])
}

export function hallazgosDeCompras(r: RegistroCompras, modo: ModoFiscal): Hallazgo[] {
  const out: Hallazgo[] = []
  const k = r.control
  const prov = r.filas.filter((f) => f.provisional)
  if (prov.length) out.push(hallazgo('COMPRAS_PROVISIONALES', tope('ADVERTENCIA', modo), 'Compras con fecha provisional', 'Les falta el tipo, la serie, el número y la fecha de emisión del documento. Complétalos desde cada compra.',
    prov.map((f) => ({ referencia: f.compra, detalle: `Recibida el ${f.recepcion}; sin documento estructurado`, importe: f.total, enlace: `/compras/${f.id}` }))))
  const sinRuc = r.filas.filter((f) => f.proveedorNombre && !(f.proveedorRuc && /^\d{11}$/.test(f.proveedorRuc)))
  if (sinRuc.length) out.push(hallazgo('COMPRAS_PROVEEDOR_SIN_RUC', tope('ADVERTENCIA', modo), 'Compras de proveedores sin RUC válido', 'Sin el RUC del proveedor el contador no puede usar la compra. Completa el proveedor.',
    sinRuc.map((f) => ({ referencia: f.compra, detalle: `${f.proveedorNombre}: ${f.proveedorRuc ?? 'sin RUC'}`, importe: f.total, enlace: `/compras/${f.id}` }))))
  if (k.sinProveedor > 0) out.push(hallazgo('COMPRAS_SIN_PROVEEDOR', tope('ADVERTENCIA', modo), 'Compras sin proveedor', 'Una compra sin proveedor no se puede sustentar.',
    r.filas.filter((f) => !f.proveedorNombre).map((f) => ({ referencia: f.compra, detalle: 'Sin proveedor', importe: f.total, enlace: `/compras/${f.id}` }))))
  return out
}

// ─── Puente y notas informativas ────────────────────────────────────────────────────────────────────────────────────

export function hallazgoDePuente(p: PuenteVentas, modo: ModoFiscal): Hallazgo | null {
  if (p.diferencia === 0) return null
  return hallazgo('PUENTE_NO_CUADRA', tope('ERROR', modo), 'El puente de ventas a comprobantes no cuadra',
    'Cada venta con comprobante debe caer en una sola categoría. La diferencia indica una venta que no se pudo clasificar: avisa a soporte.',
    [{ referencia: 'Puente de ventas', detalle: `Con comprobante ${p.conComprobante.total.toFixed(2)} − clasificado = ${p.diferencia.toFixed(2)}`, importe: p.diferencia, enlace: null }])
}

/**
 * Lo que explica diferencias legítimas, SIN alarma: el modo ensayo, las ventas anuladas y devueltas (no suman en ventas completadas) y la
 * diferencia de fechas entre la venta y la emisión de su comprobante.
 * `brutoEmitidoEnPeriodo` = suma de las boletas y facturas válidas EMITIDAS en el periodo (por la fecha de emisión), sin notas.
 */
export function hallazgosInformativos(
  p: PuenteVentas,
  modo: ModoFiscal,
  brutoEmitidoEnPeriodo: number,
  /** Boletas y facturas válidas EMITIDAS en el periodo cuya venta ya se anuló o devolvió (F6.1): no están en las ventas completadas. */
  deVentasDevueltas: LineaPuente = { documentos: 0, total: 0 },
): Hallazgo[] {
  const out: Hallazgo[] = []
  if (sinValorFiscal(modo)) {
    out.push(sinSuma('MODO_SIN_VALOR_FISCAL', 'INFO', modo === 'DEMO' ? 'Cuenta de demostración' : 'Facturación electrónica real sin habilitar',
      'Los comprobantes de este negocio son de prueba y no tienen valor fiscal: no se conciliaron como reales. Cuando habilites la facturación real, esta pantalla los revisará.', 0))
  }
  // Una venta devuelta ya no está entre las ventas completadas, pero su comprobante sigue siendo válido en el registro hasta que la nota de
  // crédito lo compense (en el periodo de la nota). Se explica aparte para que no parezca una diferencia de fechas.
  if (deVentasDevueltas.documentos > 0) {
    out.push(sinSuma('COMPROBANTES_DE_VENTAS_DEVUELTAS', 'INFO', 'Comprobantes de ventas anuladas o devueltas',
      `${deVentasDevueltas.documentos} comprobante${deVentasDevueltas.documentos === 1 ? '' : 's'} válido${deVentasDevueltas.documentos === 1 ? '' : 's'} emitido${deVentasDevueltas.documentos === 1 ? '' : 's'} en el periodo (${deVentasDevueltas.total.toFixed(2)}) cuya venta ya se anuló o devolvió: siguen sumando en el registro y su nota de crédito los compensa. Si alguno no tiene nota, aparece como error aparte.`, deVentasDevueltas.documentos))
  }
  const dif = s(c(brutoEmitidoEnPeriodo) - c(p.clasificacion.valido.total) - c(deVentasDevueltas.total))
  if (dif !== 0) out.push(hallazgo('DIFERENCIA_DE_FECHAS', 'INFO', 'Comprobantes emitidos en otro periodo que su venta',
    'Una venta del periodo cuyo comprobante se emitió después (o antes) hace que las ventas y el registro difieran sin ser un error. Se explica la diferencia, no se corrige.',
    [{ referencia: 'Ventas con comprobante válido', detalle: `Por fecha de venta ${p.clasificacion.valido.total.toFixed(2)} · por fecha de emisión ${brutoEmitidoEnPeriodo.toFixed(2)}`, importe: dif, enlace: null }]))
  const cerradas = p.anuladas.documentos + p.devueltas.documentos
  if (cerradas > 0) out.push(sinSuma('VENTAS_ANULADAS_O_DEVUELTAS', 'INFO', 'Ventas anuladas o devueltas del periodo',
    `No suman en las ventas completadas: ${p.anuladas.documentos} anulada${p.anuladas.documentos === 1 ? '' : 's'} (${p.anuladas.total.toFixed(2)}) y ${p.devueltas.documentos} devuelta${p.devueltas.documentos === 1 ? '' : 's'} (${p.devueltas.total.toFixed(2)}). Aparte se comprueba que ninguna conserve un comprobante vivo.`, cerradas))
  return out
}

// ─── El informe ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type EstadoGeneral = 'SIN_COMPROBANTES' | 'LIMPIO' | 'ADVERTENCIAS' | 'ERRORES'

export interface InformeConciliacion {
  estado: EstadoGeneral
  mensaje: string
  modo: ModoFiscal
  puente: PuenteVentas
  cuadreVentas: CuadreRegistro
  cuadreCompras: CuadreRegistro
  hallazgos: Hallazgo[]
  resumen: { errores: number; advertencias: number; informativos: number }
  /** Cuántos comprobantes REALES (no de ensayo) hay en el periodo o abiertos. 0 = nada que conciliar. */
  comprobantesReales: number
}

export const MENSAJE_SIN_COMPROBANTES = 'Sin comprobantes reales que conciliar en este periodo.'

export interface EntradaInforme {
  modo: ModoFiscal
  puente: PuenteVentas
  cuadreVentas: CuadreRegistro
  cuadreCompras: CuadreRegistro
  hallazgos: readonly Hallazgo[]
  comprobantesReales: number
  registroVentas: RegistroVentas
  comprasEnRegistro: number
}

/** Ordena los hallazgos (errores primero, luego por importe) y decide el estado. Un negocio sin nada real que conciliar sale limpio. */
export function armarInforme(e: EntradaInforme): InformeConciliacion {
  const hallazgos = [...e.hallazgos].sort((x, y) => ORDEN_NIVEL[x.nivel] - ORDEN_NIVEL[y.nivel] || Math.abs(y.importe) - Math.abs(x.importe) || (x.codigo < y.codigo ? -1 : 1))
  const resumen = { errores: hallazgos.filter((h) => h.nivel === 'ERROR').length, advertencias: hallazgos.filter((h) => h.nivel === 'ADVERTENCIA').length, informativos: hallazgos.filter((h) => h.nivel === 'INFO').length }
  const puenteMal = e.puente.diferencia !== 0
  const sinNada = e.comprobantesReales === 0 && e.comprasEnRegistro === 0 && hallazgos.every((h) => h.nivel === 'INFO')
  let estado: EstadoGeneral
  let mensaje: string
  if (resumen.errores > 0 || puenteMal) { estado = 'ERRORES'; mensaje = 'Hay diferencias que revisar.' }
  else if (resumen.advertencias > 0) { estado = 'ADVERTENCIAS'; mensaje = 'Todo cuadra, pero hay cosas que mirar.' }
  else if (sinNada) { estado = 'SIN_COMPROBANTES'; mensaje = MENSAJE_SIN_COMPROBANTES }
  else { estado = 'LIMPIO'; mensaje = 'Todo cuadra.' }
  return { estado, mensaje, modo: e.modo, puente: e.puente, cuadreVentas: e.cuadreVentas, cuadreCompras: e.cuadreCompras, hallazgos, resumen, comprobantesReales: e.comprobantesReales }
}
