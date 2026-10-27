import type { Permiso } from '@/lib/permisos'
import { PERMISOS_VER_CLIENTES, PERMISOS_VER_COBRANZA } from '@/features/clientes/permisos'
import { PERMISOS_VER_PROVEEDORES } from '@/features/proveedores/permisos'
import { PERMISOS_VER_POR_PAGAR } from '@/features/por-pagar/permisos'

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

/**
 * El panel lo ve todo rol de negocio: cada bloque decide qué enseña según sus
 * permisos. Se declara con un permiso que cada rol tiene por lo menos uno.
 */
export const PERMISOS_PANEL: readonly Permiso[] = [
  'ventas.crear', 'ventas.cobrar', 'cotizaciones.crear', 'reportes.ver', 'caja.arqueo',
  'stock.entrada', 'stock.transferir_solicitar', 'productos.crear', 'usuarios.gestionar',
]

export const NAV_ITEMS: NavItem[] = [
  {
    href: '/panel',
    label: 'Panel',
    short: 'Panel',
    // Cuadrícula
    icon: 'M4 4h7v7H4V4Zm9 0h7v4h-7V4ZM4 13h7v7H4v-7Zm9-3h7v10h-7V10Z',
    permisos: PERMISOS_PANEL,
  },
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
    href: '/clientes',
    label: 'Clientes',
    short: 'Clientes',
    // Personas
    icon: 'M17 20h5v-2a3 3 0 0 0-5.4-1.8M17 20H7m10 0v-2c0-.7-.1-1.4-.4-2M7 20H2v-2a3 3 0 0 1 5.4-1.8M7 20v-2c0-.7.1-1.4.4-2m0 0a5 5 0 0 1 9.2 0M15 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
    // Los mismos permisos que la página y el servicio: quien gestiona clientes o maneja el crédito (el cajero que cobra abonos incluido).
    permisos: [...PERMISOS_VER_CLIENTES],
  },
  {
    href: '/cobranza',
    label: 'Por cobrar',
    short: 'Cobrar',
    // Monedas
    icon: 'M12 8c-1.7 0-3 .9-3 2s1.3 2 3 2 3 .9 3 2-1.3 2-3 2m0-8c1.1 0 2.1.4 2.6 1M12 8V7m0 9v1m0-1c-1.1 0-2.1-.4-2.6-1M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
    // Los mismos permisos que la página y el servicio: quien ve clientes y el contador (revisa la cartera sin editarla).
    permisos: [...PERMISOS_VER_COBRANZA],
  },
  {
    href: '/proveedores',
    label: 'Proveedores',
    short: 'Prov.',
    // Edificio
    icon: 'M3 21h18M5 21V7l7-4 7 4v14M9 9h1m-1 4h1m4-4h1m-1 4h1M10 21v-4h4v4',
    // Los mismos permisos que la página y el servicio: quien gestiona proveedores, registra compras o paga.
    permisos: [...PERMISOS_VER_PROVEEDORES],
  },
  {
    href: '/compras',
    label: 'Compras',
    short: 'Compras',
    // Bolsa
    icon: 'M6 7h12l1 13H5L6 7Zm3 0a3 3 0 0 1 6 0',
    // Las compras se ven con los mismos permisos que los proveedores (quien compra o paga necesita verlas).
    permisos: [...PERMISOS_VER_PROVEEDORES],
  },
  {
    href: '/por-pagar',
    label: 'Por pagar',
    short: 'Pagar',
    // Billete que sale
    icon: 'M12 3v12m0 0-4-4m4 4 4-4M5 21h14',
    // Los mismos permisos que la página y el servicio: quien ve proveedores y el contador (revisa la deuda sin poder pagarla).
    permisos: [...PERMISOS_VER_POR_PAGAR],
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
    href: '/guias',
    label: 'Guías de remisión',
    short: 'Guías',
    // Camión
    icon: 'M3 7h11v9H3V7Zm11 3h4l3 3v3h-7v-6ZM7 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm10 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
    permisos: ['guias.emitir', 'guias.anular', 'reportes.ver'],
  },
  {
    href: '/pedidos',
    label: 'Pedidos',
    short: 'Pedidos',
    // Lista con visto
    icon: 'M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2M9 5h6m-6 7 2 2 4-4',
    permisos: ['ventas.crear', 'ventas.cobrar'],
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
    href: '/mermas',
    label: 'Mermas',
    short: 'Mermas',
    // Papelera
    icon: 'M4 7h16M10 11v6m4-6v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3',
    permisos: ['stock.merma_solicitar', 'stock.ajustar'],
  },
  {
    href: '/costos',
    label: 'Costos pendientes',
    short: 'Costos',
    // Etiqueta de precio
    icon: 'M3 12V5a2 2 0 0 1 2-2h7l9 9-9 9-9-9Zm5-4h.01',
    permisos: ['productos.ver_costo'],
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
    href: '/usuarios',
    label: 'Equipo',
    short: 'Equipo',
    // Personas
    icon: 'M16 11a3 3 0 1 0-6 0 3 3 0 0 0 6 0ZM4 20a6 6 0 0 1 12 0M18 8a2.5 2.5 0 1 1 0 5M20 20a5 5 0 0 0-3-4.6',
    permisos: ['usuarios.gestionar'],
  },
  {
    href: '/seguridad',
    label: 'Seguridad',
    short: 'Seguridad',
    // Escudo
    icon: 'M12 3 4 6v6c0 4.5 3.2 8.2 8 9 4.8-.8 8-4.5 8-9V6l-8-3Zm-1 11-3-3 1.4-1.4L11 11.2l3.6-3.6L16 9l-5 5Z',
    permisos: PERMISOS_PANEL,
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
