import './guard'
import { correr } from './teardown'
import { join } from 'node:path'
import {
  MATRIZ, OPCIONALES, PERMISOS, alcanzable, esOpcional, permisosDeRol,
  permisosEfectivos, ETIQUETAS, type Permiso,
} from '@/lib/permisos'
import { puede, puedeAlguno, exigir, permisosDe } from '@/lib/puede'
import type { Role } from '@/generated/prisma/enums'
import type { TenantContext } from '@/lib/tenant-context'
import { RAIZ, abrir, comparacionesDeRol, ficheros, identificadores, llamadas, proyecto, rel } from './ast'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}

const ROLES: Role[] = [
  'SUPERADMIN', 'OWNER', 'ADMIN', 'VENDEDOR', 'CAJERO', 'ALMACENERO', 'CONTADOR',
]

/**
 * INSTANTÁNEA CONGELADA de la escalera de roles anterior.
 *
 * Vive aquí y no en el código de producción por un motivo: `hasRole` y
 * `ROLE_RANK` se eliminaron al cablear `puede()`, pero la prueba de
 * equivalencia sigue necesitando saber qué podía hacer cada rol ANTES para
 * poder compararlo con lo que puede ahora. Si esta tabla viviera en
 * producción, nada impediría volver a usarla.
 *
 * No debe modificarse: es la referencia contra la que se mide el cambio.
 */
const RANGO_ANTERIOR: Record<Role, number> = {
  SUPERADMIN: 100, OWNER: 80, ADMIN: 60, ALMACENERO: 40, VENDEDOR: 20,
  CAJERO: 0, CONTADOR: 0, // no existían: la escalera los trataba como "nada"
}
const hasRole = (actual: Role, minimo: Role) => RANGO_ANTERIOR[actual] >= RANGO_ANTERIOR[minimo]

const ctxDe = (
  role: Role, extra: Permiso[] = [], deneg: Permiso[] = [], roles: Role[] = [],
): TenantContext => ({
  tenantId: 't', userId: 'u', role, roles, access: 'FULL', branchId: 'b',
  permisosExtra: extra, permisosDenegados: deneg,
})

async function main() {
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n1) El catálogo está completo y sin huecos')
  check(`${PERMISOS.length} permisos declarados (28 + 4 del crédito + clientes.gestionar + 3 de compras y proveedores + auditoria.ver)`, PERMISOS.length === 37, String(PERMISOS.length))
  check('ningún permiso repetido', new Set(PERMISOS).size === PERMISOS.length)
  check('>>> TODOS tienen etiqueta para la UI',
    PERMISOS.every((p) => ETIQUETAS[p] && ETIQUETAS[p].length > 3),
    PERMISOS.filter((p) => !ETIQUETAS[p]).join(', '))
  check('todos los roles están en la matriz',
    ROLES.every((r) => MATRIZ[r] !== undefined),
    ROLES.filter((r) => !MATRIZ[r]).join(', '))
  check('la matriz no concede permisos inventados',
    ROLES.every((r) => MATRIZ[r].every((p) => (PERMISOS as readonly string[]).includes(p))))

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n2) >>> LA MATRIZ, TAL COMO LA APROBASTE')
  check('el DUEÑO puede todo', permisosDeRol('OWNER').size === PERMISOS.length)
  check('>>> el ADMIN NO puede config.fiscal', !puede(ctxDe('ADMIN'), 'config.fiscal'))
  check('>>> el ADMIN NO puede gestionar el plan', !puede(ctxDe('ADMIN'), 'plan.gestionar'))
  check('pero sí todo lo demás',
    permisosDeRol('ADMIN').size === PERMISOS.length - 2, String(permisosDeRol('ADMIN').size))

  console.log('\n   El VENDEDOR arma pero NO cobra')
  check('puede crear la venta', puede(ctxDe('VENDEDOR'), 'ventas.crear'))
  check('>>> NO puede cobrar', !puede(ctxDe('VENDEDOR'), 'ventas.cobrar'))
  check('puede cotizar', puede(ctxDe('VENDEDOR'), 'cotizaciones.crear'))
  check('>>> NO ve costos', !puede(ctxDe('VENDEDOR'), 'productos.ver_costo'))
  check('no abre caja', !puede(ctxDe('VENDEDOR'), 'caja.abrir_cerrar'))

  console.log('\n   El CAJERO cobra pero NO ve costos')
  check('cobra', puede(ctxDe('CAJERO'), 'ventas.cobrar'))
  check('abre y cierra caja', puede(ctxDe('CAJERO'), 'caja.abrir_cerrar'))
  check('emite comprobantes', puede(ctxDe('CAJERO'), 'comprobantes.emitir'))
  check('>>> NO ve costos', !puede(ctxDe('CAJERO'), 'productos.ver_costo'))
  check('no anula ventas', !puede(ctxDe('CAJERO'), 'ventas.anular'))
  check('no toca stock', !puede(ctxDe('CAJERO'), 'stock.ajustar'))

  console.log('\n   El ALMACENERO: stock sí, costos y reportes NO')
  check('registra entradas', puede(ctxDe('ALMACENERO'), 'stock.entrada'))
  check('despacha transferencias', puede(ctxDe('ALMACENERO'), 'stock.transferir_despachar'))
  check('recibe transferencias', puede(ctxDe('ALMACENERO'), 'stock.transferir_recibir'))
  check('>>> NO ve costos', !puede(ctxDe('ALMACENERO'), 'productos.ver_costo'))
  check('>>> NO ve reportes de ventas', !puede(ctxDe('ALMACENERO'), 'reportes.ver'))
  check('no vende', !puede(ctxDe('ALMACENERO'), 'ventas.crear'))
  check('>>> NO aprueba transferencias: quien pide no autoriza',
    !puede(ctxDe('ALMACENERO'), 'stock.transferir_aprobar'))
  check('>>> SOLICITA mermas', puede(ctxDe('ALMACENERO'), 'stock.merma_solicitar'))
  check('>>> pero NO las aprueba', !puede(ctxDe('ALMACENERO'), 'stock.ajustar'))

  console.log('\n   El CONTADOR: solo lectura, pero SÍ ve costos')
  check('ve reportes', puede(ctxDe('CONTADOR'), 'reportes.ver'))
  check('ve arqueos', puede(ctxDe('CONTADOR'), 'caja.arqueo'))
  check('>>> SÍ ve costos: los necesita para la contabilidad',
    puede(ctxDe('CONTADOR'), 'productos.ver_costo'))
  check('>>> NO vende', !puede(ctxDe('CONTADOR'), 'ventas.crear'))
  check('>>> NO cobra', !puede(ctxDe('CONTADOR'), 'ventas.cobrar'))
  check('>>> NO toca stock',
    !puedeAlguno(ctxDe('CONTADOR'), 'stock.entrada', 'stock.ajustar'))

  console.log('\n   >>> El CONTADOR no cabe en una escalera')
  // Es lo que motivó el cambio: ve algo que el cajero no ve (costos) y no ve
  // algo que el cajero sí (cobrar). Ningún orden lineal expresa eso.
  const contador = permisosDe(ctxDe('CONTADOR'))
  const cajero = permisosDe(ctxDe('CAJERO'))
  check('>>> el contador tiene algo que el cajero no',
    [...contador].some((p) => !cajero.has(p)),
    [...contador].filter((p) => !cajero.has(p)).join(', '))
  check('>>> y el cajero tiene algo que el contador no',
    [...cajero].some((p) => !contador.has(p)))
  check('>>> por eso ninguno "está por encima" del otro: la escalera no servía',
    [...contador].some((p) => !cajero.has(p)) && [...cajero].some((p) => !contador.has(p)))

  // ═══════════════════════════════════════════════════════════════════════

  console.log('\n   >>> Un poder = un permiso: cerrar el turno de OTRO')
  check('>>> solo DUEÑO y ADMIN pueden cerrar el turno ajeno',
    (['OWNER', 'ADMIN'] as Role[]).every((r) => puede(ctxDe(r), 'caja.cerrar_ajeno')) &&
    (['VENDEDOR', 'CAJERO', 'ALMACENERO', 'CONTADOR'] as Role[]).every((r) => !puede(ctxDe(r), 'caja.cerrar_ajeno')))
  check('>>> el CAJERO cierra SU turno pero no el ajeno',
    puede(ctxDe('CAJERO'), 'caja.abrir_cerrar') && !puede(ctxDe('CAJERO'), 'caja.cerrar_ajeno'))

  // El caso que motivó el permiso. Con unión de roles, CAJERO + CONTADOR suma
  // `caja.abrir_cerrar` y `caja.arqueo`: la antigua intersección lo habría
  // dejado cerrar el cajón del compañero sin que ninguno de los dos roles
  // quisiera ese poder.
  const cajeroContador = ctxDe('CAJERO', [], [], ['CONTADOR'])
  check('>>> CAJERO + CONTADOR suma ambos permisos que formaban la intersección',
    puede(cajeroContador, 'caja.abrir_cerrar') && puede(cajeroContador, 'caja.arqueo'))
  check('>>> y aun así NO puede cerrar el turno de otro',
    !puede(cajeroContador, 'caja.cerrar_ajeno'))
  check('la unión suma de verdad (ve costos por el contador, cobra por el cajero)',
    puede(cajeroContador, 'ventas.cobrar') && puede(cajeroContador, 'productos.ver_costo'))

  console.log('\n   Estado manual del comprobante: permiso propio')
  check('>>> DUEÑO y ADMIN pueden',
    puede(ctxDe('OWNER'), 'comprobantes.estado_manual') && puede(ctxDe('ADMIN'), 'comprobantes.estado_manual'))
  check('>>> el CAJERO emite pero NO declara a mano la respuesta de SUNAT',
    puede(ctxDe('CAJERO'), 'comprobantes.emitir') && !puede(ctxDe('CAJERO'), 'comprobantes.estado_manual'))
  check('el CONTADOR no toca el estado de los comprobantes',
    !puede(ctxDe('CONTADOR'), 'comprobantes.estado_manual'))
  check('anular (nota de crédito) y declarar estado son permisos DISTINTOS',
    (PERMISOS as readonly string[]).includes('comprobantes.anular') &&
    (PERMISOS as readonly string[]).includes('comprobantes.estado_manual'))

  console.log('\n   El ciclo de transferencias: solicitar → aprobar → despachar → recibir')
  check('>>> vendedor y cajero SOLICITAN reposición',
    puede(ctxDe('VENDEDOR'), 'stock.transferir_solicitar') && puede(ctxDe('CAJERO'), 'stock.transferir_solicitar'))
  check('>>> pero NO despachan, NO aprueban y NO reciben',
    (['VENDEDOR', 'CAJERO'] as Role[]).every((r) =>
      !puedeAlguno(ctxDe(r), 'stock.transferir_despachar', 'stock.transferir_aprobar', 'stock.transferir_recibir')))
  check('el almacenero solicita, despacha y recibe, pero no aprueba',
    puede(ctxDe('ALMACENERO'), 'stock.transferir_solicitar') &&
    puede(ctxDe('ALMACENERO'), 'stock.transferir_despachar') &&
    puede(ctxDe('ALMACENERO'), 'stock.transferir_recibir') &&
    !puede(ctxDe('ALMACENERO'), 'stock.transferir_aprobar'))
  check('el contador no participa del ciclo',
    !puedeAlguno(ctxDe('CONTADOR'),
      'stock.transferir_solicitar', 'stock.transferir_aprobar',
      'stock.transferir_despachar', 'stock.transferir_recibir'))

  console.log('\n3) Permisos opcionales: apagados de fábrica')
  check('>>> el cajero NO descuenta de fábrica', !puede(ctxDe('CAJERO'), 'ventas.descuento'))
  check('pero es alcanzable: el dueño lo puede activar',
    alcanzable('CAJERO', 'ventas.descuento'))
  check('>>> y activado, sí puede',
    puede(ctxDe('CAJERO', ['ventas.descuento']), 'ventas.descuento'))
  check('el almacenero puede recibir stock.ajustar',
    esOpcional('ALMACENERO', 'stock.ajustar'))
  check('>>> activado, ya puede aprobar mermas',
    puede(ctxDe('ALMACENERO', ['stock.ajustar']), 'stock.ajustar'))
  check('a un CONTADOR no se le ofrece stock.ajustar: no es alcanzable',
    !alcanzable('CONTADOR', 'stock.ajustar'))
  check('los opcionales declarados existen en el catálogo',
    Object.values(OPCIONALES).flat().every((p) => p && (PERMISOS as readonly string[]).includes(p)))

  console.log('\n   Y se puede DENEGAR a una persona concreta')
  check('>>> un cajero con ventas.cobrar denegado no cobra',
    !puede(ctxDe('CAJERO', [], ['ventas.cobrar']), 'ventas.cobrar'))
  check('la denegación gana sobre el extra',
    !puede(ctxDe('CAJERO', ['ventas.descuento'], ['ventas.descuento']), 'ventas.descuento'))

  console.log('\n4) Varios roles: la UNIÓN')
  const union = permisosEfectivos(['CAJERO', 'ALMACENERO'])
  check('>>> cobra (del cajero)', union.has('ventas.cobrar'))
  check('>>> y mueve stock (del almacenero)', union.has('stock.entrada'))
  check('pero sigue sin ver costos: ninguno de los dos lo tiene',
    !union.has('productos.ver_costo'))
  check('el SUPERADMIN no tiene permisos de negocio: opera por /superadmin',
    permisosDeRol('SUPERADMIN').size === 0)

  console.log('\n5) exigir() lanza con un mensaje útil')
  let mensaje = ''
  try {
    exigir(ctxDe('VENDEDOR'), 'ventas.cobrar')
  } catch (e) {
    mensaje = (e as Error).message
  }
  check('lanza', mensaje.length > 0)
  check('>>> nombra la CAPACIDAD, no el rol',
    mensaje.toLowerCase().includes('cobrar') && !mensaje.includes('CAJERO'),
    mensaje)
  check('no lanza cuando sí puede', (() => {
    try { exigir(ctxDe('CAJERO'), 'ventas.cobrar'); return true } catch { return false }
  })())

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n6) >>> EQUIVALENCIA CON hasRole: cada diferencia, justificada')
  /*
   * Lo que pediste antes de eliminar `hasRole`: comparar los 29 sitios para
   * CADA rol, y que ninguna diferencia pase sin justificar.
   *
   * La matriz CAMBIA comportamiento a propósito —el almacenero pierde costos
   * y reportes, el vendedor pierde cobrar, el ADMIN pierde lo fiscal—, así
   * que una equivalencia estricta fallaría por diseño. Lo que esta prueba
   * exige es que TODA diferencia esté en la lista de abajo con su motivo. Una
   * que no esté es un cambio accidental, y eso es lo que hay que cazar.
   */
  interface Sitio {
    nombre: string
    rolMinimoAntes: Role
    permisoAhora: Permiso
  }
  const SITIOS: Sitio[] = [
    { nombre: 'registerSale', rolMinimoAntes: 'VENDEDOR', permisoAhora: 'ventas.cobrar' },
    { nombre: 'registerQuote', rolMinimoAntes: 'VENDEDOR', permisoAhora: 'cotizaciones.crear' },
    { nombre: 'convertQuoteToSale', rolMinimoAntes: 'VENDEDOR', permisoAhora: 'ventas.cobrar' },
    { nombre: 'issueTaxDocument', rolMinimoAntes: 'VENDEDOR', permisoAhora: 'comprobantes.emitir' },
    { nombre: 'updateTaxStatus', rolMinimoAntes: 'ADMIN', permisoAhora: 'comprobantes.estado_manual' },
    { nombre: 'closeCashSession:ajeno', rolMinimoAntes: 'ADMIN', permisoAhora: 'caja.cerrar_ajeno' },
    { nombre: 'openCashSession', rolMinimoAntes: 'VENDEDOR', permisoAhora: 'caja.abrir_cerrar' },
    { nombre: 'closeCashSession', rolMinimoAntes: 'VENDEDOR', permisoAhora: 'caja.abrir_cerrar' },
    { nombre: 'createProductExpress', rolMinimoAntes: 'ALMACENERO', permisoAhora: 'productos.crear' },
    { nombre: 'analyzeImport', rolMinimoAntes: 'ALMACENERO', permisoAhora: 'productos.crear' },
    { nombre: 'commitImport', rolMinimoAntes: 'ALMACENERO', permisoAhora: 'productos.crear' },
    { nombre: 'createStockMovement:ENTRADA', rolMinimoAntes: 'ALMACENERO', permisoAhora: 'stock.entrada' },
    { nombre: 'createStockMovement:AJUSTE', rolMinimoAntes: 'ADMIN', permisoAhora: 'stock.ajustar' },
    { nombre: 'createStockMovement:SALIDA', rolMinimoAntes: 'ALMACENERO', permisoAhora: 'stock.ajustar' },
    { nombre: 'createTransfer', rolMinimoAntes: 'ALMACENERO', permisoAhora: 'stock.transferir_solicitar' },
    { nombre: 'shipTransfer', rolMinimoAntes: 'ALMACENERO', permisoAhora: 'stock.transferir_despachar' },
    { nombre: 'receiveTransfer', rolMinimoAntes: 'ALMACENERO', permisoAhora: 'stock.transferir_recibir' },
    { nombre: 'rejectTransfer', rolMinimoAntes: 'ALMACENERO', permisoAhora: 'stock.transferir_recibir' },
    { nombre: 'approveTransfer', rolMinimoAntes: 'ADMIN', permisoAhora: 'stock.transferir_aprobar' },
    { nombre: 'createBranch', rolMinimoAntes: 'ADMIN', permisoAhora: 'sucursales.gestionar' },
    { nombre: 'updateBranch', rolMinimoAntes: 'ADMIN', permisoAhora: 'sucursales.gestionar' },
    { nombre: 'deleteBranch', rolMinimoAntes: 'ADMIN', permisoAhora: 'sucursales.gestionar' },
    { nombre: 'assignBranches', rolMinimoAntes: 'ADMIN', permisoAhora: 'usuarios.gestionar' },
    { nombre: 'fijarArranqueSerie', rolMinimoAntes: 'ADMIN', permisoAhora: 'config.fiscal' },
    { nombre: 'createCheckoutSession', rolMinimoAntes: 'ADMIN', permisoAhora: 'plan.gestionar' },
    { nombre: 'createMercadoPagoCheckout', rolMinimoAntes: 'ADMIN', permisoAhora: 'plan.gestionar' },
    { nombre: 'pagina:/sucursales', rolMinimoAntes: 'ADMIN', permisoAhora: 'sucursales.gestionar' },
    { nombre: 'pagina:/transferencias', rolMinimoAntes: 'ALMACENERO', permisoAhora: 'stock.transferir_solicitar' },
    { nombre: 'pagina:/comprobantes:series', rolMinimoAntes: 'ADMIN', permisoAhora: 'config.fiscal' },
  ]

  /** Diferencias INTENCIONADAS, con su motivo. */
  const JUSTIFICADAS: Record<string, string> = {
    // El ADMIN pierde lo fiscal y el plan: aprobado, y verificado en
    // producción que nadie lo había usado (0 veces).
    'fijarArranqueSerie|ADMIN': 'config.fiscal pasa a ser exclusivo del DUEÑO',
    'pagina:/comprobantes:series|ADMIN': 'config.fiscal pasa a ser exclusivo del DUEÑO',
    'createCheckoutSession|ADMIN': 'plan.gestionar pasa a ser exclusivo del DUEÑO',
    'createMercadoPagoCheckout|ADMIN': 'plan.gestionar pasa a ser exclusivo del DUEÑO',
    // El VENDEDOR deja de cobrar: ahora deja el pedido y lo cobra el cajero.
    'registerSale|VENDEDOR': 'el vendedor arma pero no cobra',
    'convertQuoteToSale|VENDEDOR': 'convertir cobra, y el vendedor no cobra',
    'issueTaxDocument|VENDEDOR': 'emitir acompaña al cobro, que es del cajero',
    'openCashSession|VENDEDOR': 'la caja es del cajero',
    'closeCashSession|VENDEDOR': 'la caja es del cajero',
    // El ALMACENERO pierde el ajuste directo: ahora solicita merma.
    'createStockMovement:AJUSTE|ALMACENERO': 'el ajuste exige stock.ajustar, opcional',
    'createStockMovement:SALIDA|ALMACENERO':
      'la salida manual exige stock.ajustar; para reportar una pérdida existe la merma con aprobación',
    // Y pierde lo que heredaba por rango del vendedor.
    'registerQuote|ALMACENERO': 'el almacenero no cotiza; lo heredaba por rango',
    'registerSale|ALMACENERO': 'el almacenero no vende; lo heredaba por rango',
    'convertQuoteToSale|ALMACENERO': 'el almacenero no cobra; lo heredaba por rango',
    'issueTaxDocument|ALMACENERO': 'el almacenero no emite; lo heredaba por rango',
    'openCashSession|ALMACENERO': 'el almacenero no abre caja; lo heredaba por rango',
    'closeCashSession|ALMACENERO': 'el almacenero no cierra caja; lo heredaba por rango',
  }

  /*
   * Roles que YA EXISTÍAN. La equivalencia solo tiene sentido para ellos.
   *
   * CAJERO y CONTADOR son nuevos: tienen rango 0 en la escalera vieja, así
   * que `hasRole` les dice «no» a todo. Compararlos produciría una diferencia
   * en CADA sitio, y esa diferencia no es un cambio de criterio: es que el
   * rol no existía. Mezclarlos ahogaría las diferencias que sí importan —las
   * de los roles que la gente ya tiene asignados— en ruido.
   */
  const ROLES_PREEXISTENTES: Role[] = ['OWNER', 'ADMIN', 'VENDEDOR', 'ALMACENERO']
  const ROLES_NUEVOS: Role[] = ['CAJERO', 'CONTADOR']

  /** Ampliaciones DECIDIDAS: son diferencias, y están justificadas por la decisión. */
  const CONCESIONES_APROBADAS: Record<string, string> = {
    'createTransfer|VENDEDOR':
      'aprobado: un vendedor o cajero puede SOLICITAR reposición; solo el almacenero o admin despacha',
    'pagina:/transferencias|VENDEDOR':
      'consecuencia de lo anterior: el vendedor necesita ver sus solicitudes',
  }
  const noJustificadas: string[] = []
  let comparaciones = 0
  for (const s of SITIOS) {
    for (const rol of ROLES_PREEXISTENTES) {
      comparaciones++
      const antes = hasRole(rol, s.rolMinimoAntes)
      const ahora = puede(ctxDe(rol), s.permisoAhora)
      if (antes === ahora) continue
      const clave = `${s.nombre}|${rol}`
      if (!JUSTIFICADAS[clave] && !CONCESIONES_APROBADAS[clave]) {
        noJustificadas.push(`${clave} (antes ${antes ? 'SÍ' : 'no'} → ahora ${ahora ? 'SÍ' : 'no'})`)
      }
    }
  }
  check(`>>> ${comparaciones} comparaciones (${SITIOS.length} sitios × ${ROLES_PREEXISTENTES.length} roles preexistentes)`,
    comparaciones === SITIOS.length * ROLES_PREEXISTENTES.length, String(comparaciones))
  check('>>> TODA diferencia está justificada',
    noJustificadas.length === 0,
    noJustificadas.length ? `SIN JUSTIFICAR: ${noJustificadas.join(' · ')}` : '')
  check('y la lista de justificaciones no tiene entradas muertas', (() => {
    const claves = new Set(SITIOS.flatMap((s) => ROLES.map((r) => `${s.nombre}|${r}`)))
    return Object.keys(JUSTIFICADAS).every((k) => claves.has(k))
  })(), Object.keys(JUSTIFICADAS).filter((k) => !SITIOS.some((s) => k.startsWith(`${s.nombre}|`))).join(', '))

  console.log('\n   >>> Ningún permiso se CONCEDE de más a un rol EXISTENTE')
  /*
   * La comprobación que de verdad protege: a nadie que ya tenga un rol
   * asignado se le abre algo que antes tenía cerrado SIN que se haya
   * decidido. Un permiso que se pierde se nota y alguien se queja; uno que se
   * gana por accidente no se nota nunca, y es el que hace daño.
   *
   * Hay UNA ampliación aprobada, y está aquí con su motivo para que no pueda
   * crecer en silencio.
   */
  const concesiones: string[] = []
  for (const s of SITIOS) {
    for (const rol of ROLES_PREEXISTENTES) {
      if (!hasRole(rol, s.rolMinimoAntes) && puede(ctxDe(rol), s.permisoAhora)) {
        concesiones.push(`${s.nombre}|${rol}`)
      }
    }
  }
  const sinAprobar = concesiones.filter((c) => !CONCESIONES_APROBADAS[c])
  check('>>> toda ampliación de un rol existente está aprobada y documentada',
    sinAprobar.length === 0, sinAprobar.join(' · '))
  check('y no hay aprobaciones muertas',
    Object.keys(CONCESIONES_APROBADAS).every((c) => concesiones.includes(c)),
    Object.keys(CONCESIONES_APROBADAS).filter((c) => !concesiones.includes(c)).join(', '))
  check('>>> ni el ALMACENERO ni el ADMIN ganan nada nuevo',
    concesiones.every((c) => !c.endsWith('|ALMACENERO') && !c.endsWith('|ADMIN') && !c.endsWith('|OWNER')))

  console.log('\n   Los roles NUEVOS no tenían nada: todo lo suyo es alta')
  const nuevosGanan = ROLES_NUEVOS.flatMap((rol) =>
    SITIOS.filter((s) => puede(ctxDe(rol), s.permisoAhora)).map((s) => `${s.nombre}|${rol}`),
  )
  check('>>> en la escalera vieja no podían NADA',
    ROLES_NUEVOS.every((r) => SITIOS.every((s) => !hasRole(r, s.rolMinimoAntes))))
  check(`y la matriz les da ${nuevosGanan.length} capacidades, que es el punto de crearlos`,
    nuevosGanan.length > 0)
  check('>>> ningún rol nuevo recibe config.fiscal ni plan.gestionar',
    ROLES_NUEVOS.every((r) =>
      !puedeAlguno(ctxDe(r), 'config.fiscal', 'plan.gestionar', 'usuarios.gestionar',
        'caja.cerrar_ajeno', 'comprobantes.estado_manual')))

  // ═══════════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n7) >>> AST: nadie decide permisos fuera de puede()')
  /*
   * Esto es lo que mantiene la matriz sincronizada con el código. Sin la
   * prueba, el próximo servicio copiaría el `hasRole` del de al lado y
   * heredaría un criterio que la matriz ya no dice — que es exactamente cómo
   * se llegó a 29 sitios repartidos.
   *
   * Es por AST y no por texto: un comentario que explique por qué ya no hay
   * `ctx.role === 'ADMIN'` aquí no produce ningún nodo, así que no cuenta.
   */
  const proj = proyecto()
  const EXENTOS = new Set(['src/lib/puede.ts', 'src/lib/permisos.ts'])
  const fuentes = ficheros(join(RAIZ, 'src'), (p) => p.endsWith('.ts') || p.endsWith('.tsx'))
    .map(rel)
    .filter((r) => !r.includes('/generated/'))
    .filter((r) => !EXENTOS.has(r))
  const arboles = new Map(fuentes.map((r) => [r, abrir(proj, r)]))

  const usanHasRole = fuentes.filter((r) => llamadas(arboles.get(r)!).has('hasRole'))
  check('>>> NADIE llama a hasRole', usanHasRole.length === 0, usanHasRole.join(', '))

  const conPuedeTodo = fuentes.filter((r) => identificadores(arboles.get(r)!).has('puedeTodo'))
  check('>>> puedeTodo NO existe en producción: un poder = un permiso nombrado',
    conPuedeTodo.length === 0, conPuedeTodo.join(', '))

  /*
   * `puedeAlguno` es legítimo para decidir qué PINTAR, y solo ahí. En un
   * servicio, «cualquiera de estos permisos» autoriza una operación con un
   * permiso innombrado — la misma enfermedad que `puedeTodo`, por la otra
   * puerta. Se limita a páginas, layouts y menú, donde solo controla
   * visibilidad y cada operación de dentro se guarda con su propio permiso.
   */
  const VISIBILIDAD = ['src/app/', 'src/features/shell/']
  const alguenoFuera = fuentes.filter(
    (r) => llamadas(arboles.get(r)!).has('puedeAlguno') && !VISIBILIDAD.some((v) => r.startsWith(v)),
  )
  check('>>> puedeAlguno solo aparece en páginas y menú, nunca en un servicio',
    alguenoFuera.length === 0, alguenoFuera.join(', '))

  const conRango = fuentes.filter((r) => identificadores(arboles.get(r)!).has('ROLE_RANK'))
  check('>>> nadie usa ROLE_RANK', conRango.length === 0, conRango.join(', '))

  const conMinRole = fuentes.filter((r) => identificadores(arboles.get(r)!).has('minRole'))
  check('>>> el menú ya no decide por rango mínimo', conMinRole.length === 0, conMinRole.join(', '))

  /*
   * Comparar `.role` con 'SUPERADMIN' SÍ se permite: no es un permiso, es la
   * identidad del operador de la plataforma, que no opera dentro de un
   * negocio. Cualquier otro literal ('ADMIN', 'OWNER', 'CAJERO'…) es una
   * decisión de permiso disfrazada.
   */
  const hallazgos: string[] = []
  for (const r of fuentes) {
    for (const c of comparacionesDeRol(arboles.get(r)!)) {
      if (c.valor !== 'SUPERADMIN') hallazgos.push(`${r}:${c.linea} (${c.valor})`)
    }
  }
  check('>>> nadie compara .role con un rol que no sea SUPERADMIN',
    hallazgos.length === 0, hallazgos.join(' · '))

  check('la prueba SÍ detecta la comparación prohibida (control positivo)', (() => {
    const malo = proj.createSourceFile('__malo.ts', [
      "export function f(ctx: { role: string }) {",
      "  if (ctx.role === 'ADMIN') return 1",
      "  if (['OWNER'].includes(ctx.role)) return 2",
      "  switch (ctx.role) { case 'CAJERO': return 3 }",
      "}",
    ].join('\n'), { overwrite: true })
    return comparacionesDeRol(malo).length === 3
  })())
  check('y NO se deja engañar por comentarios ni cadenas (control negativo)', (() => {
    const bueno = proj.createSourceFile('__bueno.ts', [
      "// antes aquí había ctx.role === 'ADMIN'",
      "/* y ['OWNER'].includes(ctx.role) */",
      "const texto = \"if (ctx.role === 'ADMIN')\"",
      "export const x = texto",
    ].join('\n'), { overwrite: true })
    return comparacionesDeRol(bueno).length === 0
  })())

  console.log('\n8) El menú y las páginas deciden por los MISMOS permisos')
  /*
   * Antes el menú ocultaba `/transferencias` al almacenero (exigía ADMIN) y
   * la página SÍ le dejaba entrar. Dos criterios distintos para lo mismo, y
   * nadie lo notó porque ningún test comparaba los dos. Ahora ambos salen de
   * los permisos, y esto lo comprueba.
   */
  const { NAV_ITEMS, visibleItems } = await import('@/features/shell/nav-items')
  const enMenu = (rol: Role, href: string) =>
    visibleItems([...permisosDe(ctxDe(rol))]).some((i) => i.href === href)

  check('>>> el almacenero VE transferencias en el menú (antes no)',
    enMenu('ALMACENERO', '/transferencias'))
  check('>>> el cajero y el vendedor ven transferencias: solicitan reposición',
    enMenu('CAJERO', '/transferencias') && enMenu('VENDEDOR', '/transferencias'))
  check('el contador no ve transferencias', !enMenu('CONTADOR', '/transferencias'))
  check('>>> el cajero ve caja y POS', enMenu('CAJERO', '/caja') && enMenu('CAJERO', '/pos'))
  check('>>> el contador ve comprobantes pero NO el POS',
    enMenu('CONTADOR', '/comprobantes') && !enMenu('CONTADOR', '/pos'))
  check('>>> solo el DUEÑO ve "Mi plan"',
    enMenu('OWNER', '/facturacion') && !enMenu('ADMIN', '/facturacion'))
  check('el administrador ve sucursales', enMenu('ADMIN', '/sucursales'))
  check('el vendedor no ve sucursales', !enMenu('VENDEDOR', '/sucursales'))
  check('>>> TODO rol de negocio ve el Panel (es la pantalla de aterrizaje)',
    (['OWNER', 'ADMIN', 'VENDEDOR', 'CAJERO', 'ALMACENERO', 'CONTADOR'] as Role[]).every((r) => enMenu(r, '/panel')))
  check('todos los enlaces declaran al menos un permiso del catálogo',
    NAV_ITEMS.every((i) => i.permisos.length > 0 &&
      i.permisos.every((p) => (PERMISOS as readonly string[]).includes(p))))
  check('>>> todo rol de negocio ve AL MENOS un enlace: nadie queda con un menú vacío',
    (['OWNER', 'ADMIN', 'VENDEDOR', 'CAJERO', 'ALMACENERO', 'CONTADOR'] as Role[]).every(
      (r) => visibleItems([...permisosDe(ctxDe(r))]).length > 0))

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
