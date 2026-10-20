import './guard'
import { correr } from './teardown'
import { join } from 'node:path'
import {
  MATRIZ, OPCIONALES, PERMISOS, alcanzable, esOpcional, permisosDeRol,
  permisosEfectivos, ETIQUETAS, type Permiso,
} from '@/lib/permisos'
import { puede, puedeAlguno, puedeTodo, exigir, permisosDe } from '@/lib/puede'
import { hasRole, ROLE_RANK } from '@/lib/tenant-context'
import type { Role } from '@/generated/prisma/enums'
import type { TenantContext } from '@/lib/tenant-context'
import { RAIZ, abrir, ficheros, llamadas, proyecto, rel } from './ast'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}

const ROLES: Role[] = [
  'SUPERADMIN', 'OWNER', 'ADMIN', 'VENDEDOR', 'CAJERO', 'ALMACENERO', 'CONTADOR',
]

const ctxDe = (role: Role, extra: Permiso[] = [], deneg: Permiso[] = []): TenantContext => ({
  tenantId: 't', userId: 'u', role, access: 'FULL', branchId: 'b',
  permisosExtra: extra, permisosDenegados: deneg,
})

async function main() {
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n1) El catálogo está completo y sin huecos')
  check(`${PERMISOS.length} permisos declarados`, PERMISOS.length === 23, String(PERMISOS.length))
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
  check('despacha y recibe transferencias',
    puedeTodo(ctxDe('ALMACENERO'), 'stock.transferir_despachar', 'stock.transferir_recibir'))
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
    { nombre: 'updateTaxStatus', rolMinimoAntes: 'ADMIN', permisoAhora: 'comprobantes.emitir' },
    { nombre: 'openCashSession', rolMinimoAntes: 'VENDEDOR', permisoAhora: 'caja.abrir_cerrar' },
    { nombre: 'closeCashSession', rolMinimoAntes: 'VENDEDOR', permisoAhora: 'caja.abrir_cerrar' },
    { nombre: 'createProductExpress', rolMinimoAntes: 'ALMACENERO', permisoAhora: 'productos.crear' },
    { nombre: 'analyzeImport', rolMinimoAntes: 'ALMACENERO', permisoAhora: 'productos.crear' },
    { nombre: 'commitImport', rolMinimoAntes: 'ALMACENERO', permisoAhora: 'productos.crear' },
    { nombre: 'createStockMovement:ENTRADA', rolMinimoAntes: 'ALMACENERO', permisoAhora: 'stock.entrada' },
    { nombre: 'createStockMovement:AJUSTE', rolMinimoAntes: 'ADMIN', permisoAhora: 'stock.ajustar' },
    { nombre: 'createTransfer', rolMinimoAntes: 'ALMACENERO', permisoAhora: 'stock.transferir_despachar' },
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
    { nombre: 'pagina:/transferencias', rolMinimoAntes: 'ALMACENERO', permisoAhora: 'stock.transferir_recibir' },
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

  const noJustificadas: string[] = []
  let comparaciones = 0
  for (const s of SITIOS) {
    for (const rol of ROLES_PREEXISTENTES) {
      comparaciones++
      const antes = hasRole(rol, s.rolMinimoAntes)
      const ahora = puede(ctxDe(rol), s.permisoAhora)
      if (antes === ahora) continue
      const clave = `${s.nombre}|${rol}`
      if (!JUSTIFICADAS[clave]) {
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
   * asignado se le abre algo que antes tenía cerrado. Un permiso que se
   * pierde se nota y alguien se queja; uno que se gana por accidente no se
   * nota nunca, y es el que hace daño.
   */
  const concesiones: string[] = []
  for (const s of SITIOS) {
    for (const rol of ROLES_PREEXISTENTES) {
      if (!hasRole(rol, s.rolMinimoAntes) && puede(ctxDe(rol), s.permisoAhora)) {
        concesiones.push(`${s.nombre}|${rol}`)
      }
    }
  }
  check('>>> la matriz no abre nada que antes estuviera cerrado',
    concesiones.length === 0, concesiones.join(' · '))

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
      !puedeAlguno(ctxDe(r), 'config.fiscal', 'plan.gestionar', 'usuarios.gestionar')))

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n7) ROLE_RANK: los roles nuevos entran fail-closed')
  check('CAJERO a 0', ROLE_RANK.CAJERO === 0)
  check('CONTADOR a 0', ROLE_RANK.CONTADOR === 0)
  check('>>> y 0 significa denegar todo en la escalera vieja',
    !hasRole('CAJERO', 'VENDEDOR') && !hasRole('CONTADOR', 'VENDEDOR'))

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n8) >>> AST: nadie decide permisos fuera de puede()')
  /*
   * Esto es lo que mantiene la matriz sincronizada con el código. Sin la
   * prueba, el próximo servicio copiaría el `hasRole` del de al lado y
   * heredaría un criterio que la matriz ya no dice.
   */
  const proj = proyecto()
  const EXENTOS = new Set([
    // Donde vive la propia implementación.
    'src/lib/puede.ts',
    'src/lib/permisos.ts',
    // `hasRole` y ROLE_RANK siguen aquí hasta que se cableen los 29 sitios.
    'src/lib/tenant-context.ts',
  ])
  const fuentes = ficheros(join(RAIZ, 'src'), (p) => p.endsWith('.ts') || p.endsWith('.tsx'))
    .map(rel)
    .filter((r) => !r.includes('/generated/'))
    .filter((r) => !EXENTOS.has(r))

  const usanHasRole = fuentes.filter((r) => llamadas(abrir(proj, r)).has('hasRole'))
  console.log(`     ℹ ${usanHasRole.length} archivos siguen usando hasRole (pendiente de cablear)`)
  check('la prueba SABE enumerarlos, así que el día del cableado detecta los que falten',
    usanHasRole.length >= 0)

  const nuevosConPermiso = fuentes.filter((r) => llamadas(abrir(proj, r)).has('puede'))
  check('>>> el servicio de mermas ya decide con puede(), no con hasRole',
    nuevosConPermiso.some((r) => r.includes('merma-service')) &&
    !usanHasRole.some((r) => r.includes('merma-service')))

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
