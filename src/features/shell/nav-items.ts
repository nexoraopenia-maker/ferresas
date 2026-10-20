import type { Permiso } from '@/lib/permisos'

/**
 * Elementos de navegación, en UN solo sitio.
 *
 * El sidebar de escritorio y la barra inferior de móvil consumen esta misma
 * lista. Si cada uno tuviera la suya, añadir una sección acabaría —siempre
 * acaba— apareciendo en una y no en la otra.
 */

export interface NavItem {
  href: string
  label: string
  /** Etiqueta corta para la barra inferior, donde no cabe la larga. */
  short: string
  /** Trazo del icono, dibujado con `currentColor`. */
  icon: string
  /**
   * Basta con tener UNO de estos permisos para ver el enlace.
   *
   * Antes era `minRole`, un rango mínimo, y arrastraba el defecto de toda
   * escalera: el menú ocultaba `/transferencias` al almacenero (exigía ADMIN)
   * aunque la página SÍ le dejaba entrar. El menú y la página decidían por
   * criterios distintos y nadie lo notó, porque ningún test comparaba los dos.
   *
   * Ahora el enlace y la página usan los MISMOS permisos, y
   * `tests/permisos.ts` comprueba que coinciden.
   */
  permisos: readonly Permiso[]
}

export const NAV_ITEMS: NavItem[] = [
  {
    href: '/pos',
    label: 'Punto de venta',
    short: 'Vender',
    // Carrito
    icon: 'M3 3h2l.4 2M7 13h10l3-8H5.4M7 13L5.4 5M7 13l-2 5h13M10 21a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm9 0a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z',
    permisos: ['ventas.crear', 'ventas.cobrar', 'cotizaciones.crear'],
  },
  {
    href: '/inventario',
    label: 'Inventario',
    short: 'Stock',
    // Cajas
    icon: 'M20 7 12 3 4 7m16 0-8 4m8-4v10l-8 4m0-14L4 7m8 4v10M4 7v10l8 4',
    permisos: ['stock.entrada', 'stock.ajustar', 'stock.merma_solicitar', 'productos.crear'],
  },
  {
    href: '/cotizaciones',
    label: 'Cotizaciones',
    short: 'Cotiz.',
    // Etiqueta con precio
    icon: 'M7 7h.01M7 3h5a2 2 0 0 1 1.4.6l7 7a2 2 0 0 1 0 2.8l-5.6 5.6a2 2 0 0 1-2.8 0l-7-7A2 2 0 0 1 4 10.6V5a2 2 0 0 1 2-2h1Z',
    permisos: ['cotizaciones.crear'],
  },
  {
    href: '/comprobantes',
    label: 'Comprobantes',
    short: 'Docs',
    // Documento
    icon: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Zm0 0v5h5M9 13h6M9 17h4',
    // El contador los consulta sin poder emitirlos: por eso `reportes.ver`.
    permisos: ['comprobantes.emitir', 'comprobantes.anular', 'reportes.ver'],
  },
  {
    href: '/caja',
    label: 'Caja',
    short: 'Caja',
    // Billetes
    icon: 'M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8Zm9 7a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
    permisos: ['caja.abrir_cerrar', 'caja.arqueo'],
  },
  {
    href: '/transferencias',
    label: 'Transferencias',
    short: 'Traslad.',
    // Flechas entre locales
    icon: 'M4 7h12m0 0-3-3m3 3-3 3M20 17H8m0 0 3 3m-3-3 3-3',
    permisos: ['stock.transferir_solicitar', 'stock.transferir_despachar', 'stock.transferir_recibir', 'stock.transferir_aprobar'],
  },
  {
    href: '/sucursales',
    label: 'Sucursales',
    short: 'Local.',
    // Tiendas
    icon: 'M3 21h18M5 21V9l7-5 7 5v12M9 21v-6h6v6',
    permisos: ['sucursales.gestionar'],
  },
  {
    href: '/facturacion',
    label: 'Mi plan',
    short: 'Plan',
    // Tarjeta
    icon: 'M3 10h18M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Zm4 7h3',
    // Contratar y pagar es decisión del dueño, no del cajero: el enlace no
    // se muestra a quien no puede usarlo.
    permisos: ['plan.gestionar'],
  },
]

export function visibleItems(permisos: readonly string[]): NavItem[] {
  const tiene = new Set(permisos)
  return NAV_ITEMS.filter((i) => i.permisos.some((p) => tiene.has(p)))
}

/**
 * ¿Está activo este enlace?
 *
 * Coincidencia por prefijo para que `/inventario/algo` siga marcando
 * «Inventario», pero exacta en la raíz para no encender todo a la vez.
 */
export function isActive(href: string, pathname: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`)
}
