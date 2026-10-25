import type { Role } from '@/generated/prisma/enums'

/**
 * Permisos nombrados. La única autoridad sobre quién puede hacer qué.
 *
 * ─── POR QUÉ NO BASTABA LA ESCALERA DE ROLES ─────────────────────────────
 *
 * Hasta ahora los permisos eran una escalera: `ROLE_RANK` daba un número a
 * cada rol y `hasRole(actual, minimo)` comparaba. Simple, y con un límite
 * duro: NO se puede dar un permiso a un rol bajo sin dárselo a todos los de
 * arriba, ni quitárselo a uno de arriba.
 *
 * Dos casos reales que la escalera no sabe expresar:
 *
 *   · El CONTADOR ve reportes y comprobantes pero no vende ni toca stock. No
 *     está «por encima» ni «por debajo» del cajero: está al lado.
 *   · Ver el COSTO es información sensible —es el margen del negocio—. Un
 *     almacenero no debería verlo, pero sí registrar entradas. Con la
 *     escalera, cualquier permiso del vendedor lo heredaba el almacenero.
 *
 * ─── CÓMO SE USA ─────────────────────────────────────────────────────────
 *
 * SIEMPRE con `puede(ctx, 'permiso')`. Nunca comparando `ctx.role` a mano:
 * `tests/permisos.ts` tiene una prueba por AST que falla si alguien vuelve a
 * hacerlo, porque es así como la matriz se va desincronizando del código.
 */

export const PERMISOS = [
  'ventas.crear',
  'ventas.cobrar',
  'ventas.anular',
  'ventas.descuento',
  'credito.otorgar',
  'credito.cobrar',
  'credito.limite',
  'credito.castigar',
  'cotizaciones.crear',
  'caja.abrir_cerrar',
  'caja.arqueo',
  'caja.cerrar_ajeno',
  'productos.ver_costo',
  'productos.editar_precio',
  'productos.crear',
  'stock.entrada',
  'stock.ajustar',
  'stock.merma_solicitar',
  'stock.transferir_solicitar',
  'stock.transferir_aprobar',
  'stock.transferir_despachar',
  'stock.transferir_recibir',
  'reportes.ver',
  'comprobantes.emitir',
  'comprobantes.anular',
  'comprobantes.estado_manual',
  'guias.emitir',
  'guias.anular',
  'usuarios.gestionar',
  'sucursales.gestionar',
  'config.fiscal',
  'plan.gestionar',
] as const

export type Permiso = (typeof PERMISOS)[number]

/**
 * Permisos que NO vienen de fábrica y el dueño activa a mano.
 *
 * Existen porque son decisiones de confianza, no de puesto: hay ferreterías
 * donde el cajero puede descontar y otras donde no, y acertar por defecto es
 * imposible. Apagados de fábrica porque el error de concederlos de más es
 * peor que el de pedirlo: un descuento indebido sale del margen, y un
 * almacenero ajustando stock a su criterio tapa faltantes.
 */
export const OPCIONALES: Partial<Record<Role, readonly Permiso[]>> = {
  VENDEDOR: ['ventas.descuento'],
  // Fiar es una decisión de confianza sobre dinero que no está en el cajón: apagado de fábrica, lo activa el dueño. Solo el CAJERO
  // (quien cobra); el VENDEDOR arma pedidos y no cobra, así que no tendría dónde usarlo.
  CAJERO: ['ventas.descuento', 'credito.otorgar'],
  ALMACENERO: ['productos.editar_precio', 'stock.ajustar'],
}

/**
 * Matriz rol → permisos concedidos DE FÁBRICA.
 *
 * Un usuario puede tener varios roles y se queda con la UNIÓN. No hay
 * herencia entre roles: cada uno declara lo suyo, explícito. Es más verboso
 * y es el punto: con herencia, añadir un permiso a un rol bajo lo filtra
 * hacia arriba sin que nadie lo decida.
 */
export const MATRIZ: Record<Role, readonly Permiso[]> = {
  /** El dueño del SaaS. No opera dentro de un negocio: entra por /superadmin. */
  SUPERADMIN: [],

  OWNER: [...PERMISOS],

  /**
   * Todo excepto lo fiscal y el plan.
   *
   * `config.fiscal` toca la numeración tributaria y el certificado digital:
   * un correlativo inicial mal puesto emite números ya usados bajo el RUC del
   * negocio, y eso no se deshace. `plan.gestionar` mueve dinero del dueño.
   * Ninguna de las dos es una tarea delegable a un administrador.
   */
  ADMIN: PERMISOS.filter((p) => p !== 'config.fiscal' && p !== 'plan.gestionar'),

  /**
   * Atiende el mostrador: arma el pedido y cotiza. NO cobra ni ve costos.
   *
   * Separar «armar» de «cobrar» es lo que permite el relevo vendedor → cajero
   * sin que el vendedor toque el dinero.
   */
  VENDEDOR: [
    'ventas.crear',
    'cotizaciones.crear',
    // Despacha lo que vende: la guía acompaña a la mercadería.
    'guias.emitir',
    // Pedir mercadería es solicitar, no despachar: el ciclo es
    // solicitar → aprobar → despachar → recibir, y cada paso es de alguien
    // distinto. Un vendedor o cajero puede pedir reposición para su tienda;
    // solo el almacenero o el admin despacha.
    'stock.transferir_solicitar',
  ],

  /** Cobra, abre y cierra caja, emite comprobantes. NO ve costos. */
  CAJERO: [
    'ventas.crear',
    'ventas.cobrar',
    // Registra los abonos de los clientes con deuda (entra dinero al cajón). Fiar (`credito.otorgar`), cambiar la línea
    // (`credito.limite`) y dar de baja una deuda (`credito.castigar`) NO vienen de fábrica.
    'credito.cobrar',
    'cotizaciones.crear',
    'caja.abrir_cerrar',
    'comprobantes.emitir',
    'guias.emitir',
    'stock.transferir_solicitar',
  ],

  /**
   * Stock, transferencias y recepción. NO vende, NO ve costos, NO ve
   * reportes de ventas.
   *
   * `stock.entrada` sin `productos.ver_costo` es deliberado: registra la
   * mercadería que llega con sus cantidades, y el costo lo completa después
   * quien pueda verlo. Mientras falte, la entrada queda en «costo pendiente»
   * y NO recalcula el costo promedio — si lo recalculara con cero, el margen
   * de ese producto se dispararía y el error se propagaría a los reportes.
   */
  ALMACENERO: [
    'productos.crear',
    'stock.entrada',
    // Prepara y despacha la mercadería: emite la guía que la acompaña.
    'guias.emitir',
    /*
     * SOLICITAR una merma, no aplicarla.
     *
     * Una merma reduce inventario a criterio de quien la registra, y eso es
     * exactamente lo que no debe hacer nadie sin supervisión: es la forma más
     * fácil de tapar un faltante. Así que el almacenero la pide —con
     * cantidad, motivo y opcionalmente una foto— y el stock NO se mueve hasta
     * que alguien con `stock.ajustar` la aprueba.
     *
     * Misma regla que en transferencias: quien pide no autoriza.
     */
    'stock.merma_solicitar',
    'stock.transferir_solicitar',
    'stock.transferir_despachar',
    'stock.transferir_recibir',
  ],

  /** Solo lectura: reportes, comprobantes y arqueos. Sí ve costos. */
  CONTADOR: ['reportes.ver', 'caja.arqueo', 'productos.ver_costo'],
}

/** Permisos de fábrica de un rol. */
export function permisosDeRol(rol: Role): Set<Permiso> {
  return new Set(MATRIZ[rol] ?? [])
}

/**
 * Permisos efectivos de un conjunto de roles: la UNIÓN.
 *
 * `extra` son los opcionales que el dueño activó; `denegados` permite quitar
 * uno concreto a un usuario sin cambiar su rol.
 */
export function permisosEfectivos(
  roles: readonly Role[],
  extra: readonly Permiso[] = [],
  denegados: readonly Permiso[] = [],
): Set<Permiso> {
  const out = new Set<Permiso>()
  for (const r of roles) for (const p of permisosDeRol(r)) out.add(p)
  for (const p of extra) out.add(p)
  for (const p of denegados) out.delete(p)
  return out
}

/** ¿Es `p` un permiso que este rol puede recibir activándolo a mano? */
export function esOpcional(rol: Role, p: Permiso): boolean {
  return (OPCIONALES[rol] ?? []).includes(p)
}

/**
 * ¿Puede este rol llegar a tener el permiso, de fábrica o activándolo?
 *
 * Sirve para la UI de gestión: ofrecer activar `stock.ajustar` a un CONTADOR
 * no tiene sentido, y la pantalla debe saberlo sin codificarlo otra vez.
 */
export function alcanzable(rol: Role, p: Permiso): boolean {
  return permisosDeRol(rol).has(p) || esOpcional(rol, p)
}

/** Texto para la UI. Se muestra al dueño cuando configura permisos. */
export const ETIQUETAS: Record<Permiso, string> = {
  'ventas.crear': 'Armar ventas y pedidos',
  'ventas.cobrar': 'Cobrar',
  'ventas.anular': 'Anular ventas cobradas',
  'ventas.descuento': 'Aplicar descuentos',
  'credito.otorgar': 'Vender a crédito (fiar)',
  'credito.cobrar': 'Registrar abonos de clientes con deuda',
  'credito.limite': 'Cambiar la línea de crédito, el plazo o bloquear a un cliente',
  'credito.castigar': 'Dar de baja o castigar una deuda y anular abonos',
  'cotizaciones.crear': 'Cotizar',
  'caja.abrir_cerrar': 'Abrir y cerrar caja',
  'caja.arqueo': 'Ver arqueos y descuadres',
  'caja.cerrar_ajeno': 'Cerrar el turno de caja de otra persona',
  'productos.ver_costo': 'Ver costos y márgenes',
  'productos.editar_precio': 'Cambiar precios de venta',
  'productos.crear': 'Crear productos',
  'stock.entrada': 'Registrar entradas de mercadería',
  'stock.ajustar': 'Ajustar stock y aprobar mermas',
  'stock.merma_solicitar': 'Solicitar mermas (requieren aprobación)',
  'stock.transferir_solicitar': 'Solicitar transferencias entre sucursales',
  'stock.transferir_despachar': 'Despachar transferencias',
  'stock.transferir_aprobar': 'Aprobar transferencias',
  'stock.transferir_recibir': 'Recibir transferencias',
  'reportes.ver': 'Ver reportes',
  'comprobantes.emitir': 'Emitir boletas y facturas',
  'comprobantes.anular': 'Emitir notas de crédito',
  'comprobantes.estado_manual': 'Cambiar a mano el estado tributario de un comprobante',
  'guias.emitir': 'Emitir guías de remisión',
  'guias.anular': 'Anular guías de remisión',
  'usuarios.gestionar': 'Gestionar usuarios',
  'sucursales.gestionar': 'Gestionar sucursales',
  'config.fiscal': 'Configurar series y datos fiscales',
  'plan.gestionar': 'Contratar y pagar el plan',
}
