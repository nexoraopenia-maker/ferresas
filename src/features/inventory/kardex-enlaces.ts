/**
 * Lo PURO de la pantalla del kardex (F6.4c): leer los filtros de la dirección, armar los enlaces (a la propia pantalla y al CSV) y nombrar cada movimiento
 * en cristiano. Sin React ni base de datos, para probarlo a fondo. Los enlaces conservan los filtros: cambiar de página o de rango no pierde el producto.
 */

export interface FiltrosKardexUrl {
  producto?: string
  almacen?: string
  variante?: string
  desde?: string
  hasta?: string
  cursor?: string
  q?: string
}

const CLAVES: readonly (keyof FiltrosKardexUrl)[] = ['producto', 'almacen', 'variante', 'desde', 'hasta', 'cursor', 'q']
const MAX: Record<keyof FiltrosKardexUrl, number> = { producto: 64, almacen: 64, variante: 64, desde: 10, hasta: 10, cursor: 200, q: 80 }

/** Lee los filtros de `searchParams` de Next: toma el primer valor, recorta espacios y largos, y descarta lo vacío. Nunca lanza. */
export function leerFiltros(sp: Record<string, string | string[] | undefined>): FiltrosKardexUrl {
  const out: FiltrosKardexUrl = {}
  for (const k of CLAVES) {
    const v = sp[k]
    const t = (Array.isArray(v) ? v[0] : v)?.trim()
    if (t) out[k] = t.slice(0, MAX[k])
  }
  return out
}

function consulta(f: FiltrosKardexUrl, claves: readonly (keyof FiltrosKardexUrl)[], nombres: Partial<Record<keyof FiltrosKardexUrl, string>> = {}): string {
  const partes: string[] = []
  for (const k of claves) {
    const v = f[k]
    if (v) partes.push(`${nombres[k] ?? k}=${encodeURIComponent(v)}`)
  }
  return partes.join('&')
}

/** La pantalla del kardex con estos filtros (en este orden, para que los enlaces sean estables). */
export function enlaceKardex(f: FiltrosKardexUrl): string {
  const q = consulta(f, ['producto', 'almacen', 'variante', 'desde', 'hasta', 'cursor', 'q'])
  return q ? `/inventario/kardex?${q}` : '/inventario/kardex'
}

/** La descarga CSV del mismo kardex (el rango completo: no lleva cursor ni búsqueda). `null` sin producto. */
export function enlaceCsvKardex(f: FiltrosKardexUrl): string | null {
  if (!f.producto) return null
  return `/api/inventario/kardex?${consulta(f, ['producto', 'almacen', 'variante', 'desde', 'hasta'], { producto: 'productId', almacen: 'warehouseId', variante: 'variantId' })}`
}

const TIPOS: Record<string, string> = {
  INICIAL: 'Stock inicial', ENTRADA: 'Entrada', SALIDA: 'Salida', AJUSTE: 'Ajuste de inventario', MERMA: 'Merma',
  TRANSFERENCIA_ENTRADA: 'Transferencia (llega)', TRANSFERENCIA_SALIDA: 'Transferencia (sale)',
  DEVOLUCION_CLIENTE: 'Devolución de cliente', DEVOLUCION_PROVEEDOR: 'Devolución a proveedor', VENTA: 'Venta',
}
const ORIGEN_DOCUMENTO: Record<string, string> = { VENTA: 'Venta', COMPRA: 'Compra', DEVOLUCION: 'Devolución', TRANSFERENCIA: 'Transferencia', MERMA: 'Merma', CONTEO: 'Toma de inventario', MANUAL: '' }

/** Cómo se llama un movimiento: el documento manda (una venta es «Venta» aunque por dentro sea una salida), si no, su tipo. */
export function etiquetaMovimiento(l: { tipo: string; entrada: number; documento: { tipo: string } }): string {
  switch (l.documento.tipo) {
    case 'VENTA': return l.entrada > 0 ? 'Reingreso de venta' : 'Venta'
    case 'COMPRA': return l.entrada > 0 ? 'Compra' : 'Anulación de compra'
    case 'CONTEO': return l.entrada > 0 ? 'Ajuste por conteo (sobrante)' : 'Ajuste por conteo (faltante)'
    case 'DEVOLUCION': return l.tipo === 'MERMA' ? 'Devolución dañada (merma)' : 'Devolución de cliente'
    default: return TIPOS[l.tipo] ?? l.tipo
  }
}

/** El documento de una línea para mostrarlo: «Venta B001-12», o solo el tipo si no hay número, o nada si es un movimiento manual. */
export function textoDocumento(d: { tipo: string; numero: string | null }): string {
  const t = ORIGEN_DOCUMENTO[d.tipo] ?? ''
  return [t, d.numero].filter(Boolean).join(' ')
}

export const ETIQUETA_ORIGEN_COSTO: Record<'EXACTO' | 'RECONSTRUIDO' | 'SIN_DATO', string> = { EXACTO: 'Exacto', RECONSTRUIDO: 'Reconstruido', SIN_DATO: 'Sin dato' }
export const AYUDA_ORIGEN_COSTO: Record<'EXACTO' | 'RECONSTRUIDO' | 'SIN_DATO', string> = {
  EXACTO: 'El sistema guardó este costo en el momento del movimiento.',
  RECONSTRUIDO: 'Calculado repitiendo compras y ventas anteriores: es una estimación, no una certeza.',
  SIN_DATO: 'No se puede saber el costo de este movimiento (es anterior al kardex valorizado).',
}
