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
  /** Mínimo rol que lo ve. Sin valor, lo ve cualquiera con sesión. */
  minRole?: 'ADMIN' | 'OWNER'
}

export const NAV_ITEMS: NavItem[] = [
  {
    href: '/pos',
    label: 'Punto de venta',
    short: 'Vender',
    // Carrito
    icon: 'M3 3h2l.4 2M7 13h10l3-8H5.4M7 13L5.4 5M7 13l-2 5h13M10 21a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm9 0a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z',
  },
  {
    href: '/inventario',
    label: 'Inventario',
    short: 'Stock',
    // Cajas
    icon: 'M20 7 12 3 4 7m16 0-8 4m8-4v10l-8 4m0-14L4 7m8 4v10M4 7v10l8 4',
  },
  {
    href: '/cotizaciones',
    label: 'Cotizaciones',
    short: 'Cotiz.',
    // Etiqueta con precio
    icon: 'M7 7h.01M7 3h5a2 2 0 0 1 1.4.6l7 7a2 2 0 0 1 0 2.8l-5.6 5.6a2 2 0 0 1-2.8 0l-7-7A2 2 0 0 1 4 10.6V5a2 2 0 0 1 2-2h1Z',
  },
  {
    href: '/comprobantes',
    label: 'Comprobantes',
    short: 'Docs',
    // Documento
    icon: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Zm0 0v5h5M9 13h6M9 17h4',
  },
  {
    href: '/facturacion',
    label: 'Mi plan',
    short: 'Plan',
    // Tarjeta
    icon: 'M3 10h18M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Zm4 7h3',
    // Contratar y pagar es decisión del dueño, no del cajero: el enlace no
    // se muestra a quien no puede usarlo.
    minRole: 'ADMIN',
  },
]

const RANGO: Record<string, number> = {
  SUPERADMIN: 100, OWNER: 80, ADMIN: 60, ALMACENERO: 40, VENDEDOR: 20,
}

export function visibleItems(role: string): NavItem[] {
  return NAV_ITEMS.filter(
    (i) => !i.minRole || (RANGO[role] ?? 0) >= (RANGO[i.minRole] ?? 0),
  )
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
