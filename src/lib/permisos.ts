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
  'clientes.gestionar',
  'proveedores.gestionar',
  'compras.registrar',
  'proveedores.pagar',
  'cotizaciones.crear',
  'caja.abrir_cerrar',
  'caja.arqueo',
  'caja.cerrar_ajeno',
  'caja.movimientos',
  'caja.ajuste',
  // Varias cajas por sucursal (F6.8): administrar las cajas (crear, renombrar, dar de baja) y ver el consolidado del día de la sucursal. Abrir y cerrar SU turno sigue siendo `caja.abrir_cerrar`.
  'caja.administrar',
  'caja.consolidado',
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
  // Ver el kardex (cada movimiento de stock de un producto, con su saldo) en UNIDADES. Los valores y costos siguen siendo `productos.ver_costo` (F6.4).
  'kardex.ver',
  // Toma de inventario físico (F6.5): contar (pasadas) y gestionar el conteo (crear, iniciar, cerrar, cancelar). Aplicar las diferencias es `stock.ajustar`.
  'conteo.registrar',
  'conteo.gestionar',
  // Stock mínimo y reposición (F6.6): ver lo que hay que reponer (en unidades; el costo estimado sigue siendo `productos.ver_costo`) y fijar mínimos y máximos.
  // Crear el borrador de compra es `compras.registrar`; pedir una transferencia, `stock.transferir_solicitar`.
  'reposicion.ver',
  'reposicion.configurar',
  // Listas de precio y precio por volumen (F6.7): gestionarlas (crear listas, fijar precios y tramos, asignar la lista de un cliente) y vender por debajo del costo promedio.
  // Elegir una lista al vender no es un permiso aparte: quien vende o cotiza las ve todas.
  'precios.gestionar',
  'ventas.bajo_costo',
  'comprobantes.emitir',
  'comprobantes.anular',
  // Comunicar a SUNAT la baja de una factura ya aceptada (S4, dentro del plazo). Es otro poder que emitir una nota de crédito.
  'comprobantes.dar_baja',
  'comprobantes.estado_manual',
  'guias.emitir',
  'guias.anular',
  'usuarios.gestionar',
  'sucursales.gestionar',
  // El registro de auditoría muestra quién hizo qué, con el antes y el después: solo dueño y administrador (ver MATRIZ: ADMIN lo hereda al
  // ser «todo menos lo fiscal y el plan»). No es opcional: nadie más puede recibirlo.
  'auditoria.ver',
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
  // Registrar una compra implica ver y teclear COSTOS: el almacenero no los ve de fábrica, así que lo activa el dueño si de verdad lo quiere así.
  ALMACENERO: ['productos.editar_precio', 'stock.ajustar', 'compras.registrar', 'conteo.gestionar', 'reposicion.configurar'],
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
    // (`credito.limite`) y dar de baja una deuda (`credito.castigar`) NO vienen de fábrica. Con `credito.cobrar` también VE la lista y la
    // ficha de los clientes (para encontrar a quien abona), pero no edita sus datos: eso es `clientes.gestionar`, solo de dueño y admin.
    'credito.cobrar',
    'cotizaciones.crear',
    'caja.abrir_cerrar',
    // Gastos menores y otros movimientos pequeños del cajón, hasta un tope por movimiento (`TOPE_MOVIMIENTO_SIN_AJUSTE`). Lo demás es `caja.ajuste`.
    'caja.movimientos',
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
    // Ve el kardex en unidades (sin costos): es quien mueve el stock y necesita saber por qué cambió.
    'kardex.ver',
    // Cuenta la mercadería (pasadas); crear, cerrar o cancelar un conteo no viene de fábrica (`conteo.gestionar`).
    'conteo.registrar',
    // Ve qué reponer (sin costos); fijar los mínimos y máximos no viene de fábrica (`reposicion.configurar`).
    'reposicion.ver',
  ],

  /** Solo lectura: reportes, comprobantes, arqueos, kardex y reposición. Sí ve costos. */
  CONTADOR: ['reportes.ver', 'caja.arqueo', 'productos.ver_costo', 'kardex.ver', 'reposicion.ver'],
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
  'clientes.gestionar': 'Crear, editar y dar de baja clientes',
  'proveedores.gestionar': 'Crear, editar y dar de baja proveedores',
  'compras.registrar': 'Registrar compras de mercadería (con sus costos)',
  'proveedores.pagar': 'Pagar a proveedores (sale dinero del negocio)',
  'cotizaciones.crear': 'Cotizar',
  'caja.abrir_cerrar': 'Abrir y cerrar caja',
  'caja.arqueo': 'Ver arqueos y descuadres',
  'caja.cerrar_ajeno': 'Cerrar el turno de caja de otra persona',
  'caja.movimientos': 'Registrar gastos menores y otros movimientos de caja pequeños',
  'caja.administrar': 'Crear, renombrar y dar de baja las cajas de una sucursal',
  'caja.consolidado': 'Ver el consolidado del día de todas las cajas de una sucursal',
  'caja.ajuste': 'Registrar cualquier ingreso o egreso de caja, corregir arqueos y compensar abonos de turnos cerrados',
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
  'kardex.ver': 'Ver el kardex de un producto (en unidades; los valores necesitan ver costos)',
  'conteo.registrar': 'Contar mercadería en una toma de inventario',
  'conteo.gestionar': 'Crear, iniciar, cerrar y cancelar tomas de inventario',
  'reposicion.ver': 'Ver qué productos reponer y cuánto',
  'reposicion.configurar': 'Fijar los stocks mínimos y máximos de reposición',
  'precios.gestionar': 'Gestionar listas de precio, precios por volumen y la lista de cada cliente',
  'ventas.bajo_costo': 'Vender por debajo del costo promedio',
  'comprobantes.emitir': 'Emitir boletas y facturas',
  'comprobantes.anular': 'Emitir notas de crédito',
  'comprobantes.dar_baja': 'Comunicar a SUNAT la baja de una factura (comunicación de baja)',
  'comprobantes.estado_manual': 'Cambiar a mano el estado tributario de un comprobante',
  'guias.emitir': 'Emitir guías de remisión',
  'guias.anular': 'Anular guías de remisión',
  'usuarios.gestionar': 'Gestionar usuarios',
  'sucursales.gestionar': 'Gestionar sucursales',
  'auditoria.ver': 'Ver el registro de auditoría (quién hizo qué)',
  'config.fiscal': 'Configurar series y datos fiscales',
  'plan.gestionar': 'Contratar y pagar el plan',
}
