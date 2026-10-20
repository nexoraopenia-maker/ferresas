import { prisma } from '@/lib/prisma'

/**
 * Limpieza automática al terminar un fichero de pruebas.
 *
 * ─── EL PROBLEMA QUE RESUELVE ────────────────────────────────────────────
 *
 * Staging acumuló 280 tenants de residuo. Dos causas, y las dos son de
 * diseño, no descuidos:
 *
 *   1. Ocho ficheros creaban tenants y nunca los borraban.
 *   2. Los que SÍ limpiaban lo hacían al final de `main()`, así que una
 *      aserción que fallara a mitad —exactamente cuando más interesa mirar
 *      la base— se saltaba la limpieza.
 *
 * Y había un tercer motivo más sutil: `process.exit()` dentro de `main()`
 * mata el proceso en el acto, así que un `finally` colocado después nunca
 * llegaba a ejecutarse. De ahí que la salida se centralice aquí.
 *
 * ─── CÓMO DECIDE QUÉ BORRAR ──────────────────────────────────────────────
 *
 * Por VENTANA DE TIEMPO: todo tenant creado después de que arrancara este
 * fichero. No por prefijo de slug, porque entonces un test nuevo con un
 * prefijo no previsto volvería a filtrar en silencio — que es precisamente
 * cómo se llegó a 280.
 *
 * La lista de prefijos conocidos existe solo para AVISAR: si se borra algo
 * que no encaja, se imprime. Así un borrado inesperado se ve en lugar de
 * pasar desapercibido.
 */

/**
 * Momento en que este fichero empezó a CREAR datos.
 *
 * No es el momento en que arrancó el proceso: se reinicia al conseguir el
 * lock (ver `correr`). Si fuera el del arranque, esperar el lock contaría
 * como "tiempo propio" y el teardown podría llevarse tenants ajenos creados
 * mientras esperábamos.
 */
let INICIO = new Date()

/**
 * Clave del lock de Postgres que serializa las ejecuciones de la suite.
 * Cualquier entero de 64 bits vale mientras sea siempre el mismo.
 */
const LOCK_KEY = 7_424_001_001

/** Nunca se tocan, ni estando dentro de la ventana. */
const INTOCABLES = new Set(['sol', 'luna'])

/** Prefijos esperados. Solo para avisar de lo inesperado. */
const PREFIJOS_CONOCIDOS = [
  'f-', 'co-', 'mp-', 'tr-', 'wh-', 'sa-', 'suc-', 'f3-', 'dbg-', 'sm-', 's3-',
  'print-', 'print2-', 'pos-', 'tope-', 'ferre-a-', 'ferre-b-', 'qty-',
  'ferreteria-sol-', 'ferreteria-norte', 'stock-', 'imp-', 'iso-',
]

export interface ResultadoTeardown {
  tenants: number
  planes: number
  inesperados: string[]
}

/** Borra lo que este fichero de pruebas haya creado. */
export async function limpiarResiduo(): Promise<ResultadoTeardown> {
  const candidatos = await prisma.tenant.findMany({
    where: { createdAt: { gte: INICIO } },
    select: { id: true, slug: true },
  })

  const aBorrar = candidatos.filter((t) => !INTOCABLES.has(t.slug))
  const inesperados = aBorrar
    .filter((t) => !PREFIJOS_CONOCIDOS.some((p) => t.slug.startsWith(p)))
    .map((t) => t.slug)

  if (aBorrar.length > 0) {
    const ids = aBorrar.map((t) => t.id)
    /*
     * Los comprobantes primero: `TaxDocument.sale` es onDelete Restrict, así
     * que la cascada del tenant no puede borrar una venta que tenga
     * comprobante emitido.
     */
    await prisma.taxDocument.deleteMany({ where: { tenantId: { in: ids } } })
    await prisma.tenant.deleteMany({ where: { id: { in: ids } } })
  }

  // Algunos tests crean planes propios para probar límites.
  const planes = await prisma.plan.deleteMany({
    where: { createdAt: { gte: INICIO }, code: { not: { in: ['free', 'basico', 'premium'] } } },
  })

  return { tenants: aBorrar.length, planes: planes.count, inesperados }
}

/**
 * Punto de entrada de los ficheros de prueba que tocan la base.
 *
 * `main` devuelve el número de fallos en lugar de llamar a `process.exit`:
 * así la limpieza ocurre SIEMPRE —pase, falle o reviente— y el código de
 * salida se decide en un solo sitio.
 */
export async function correr(main: () => Promise<number | void>): Promise<never> {
  let codigo = 1
  const liberar = await tomarLock()
  INICIO = new Date()
  try {
    const fallos = await main()
    codigo = typeof fallos === 'number' && fallos > 0 ? 1 : 0
  } catch (e) {
    console.error(e)
    codigo = 1
  } finally {
    try {
      const r = await limpiarResiduo()
      if (r.tenants > 0 || r.planes > 0) {
        console.log(
          `  ⌫ teardown: ${r.tenants} tenant(s)` +
            (r.planes > 0 ? ` y ${r.planes} plan(es)` : '') +
            ' de prueba eliminados',
        )
      }
      if (r.inesperados.length > 0) {
        console.log(
          `  ⚠ teardown borró slugs no previstos: ${r.inesperados.join(', ')}. ` +
            'Si alguno es real, añádelo a INTOCABLES en tests/teardown.ts.',
        )
      }
    } catch (e) {
      // Que el teardown falle no debe enmascarar el resultado de las pruebas.
      console.error('  ⚠ el teardown falló:', e instanceof Error ? e.message : e)
    }
    await prisma.$disconnect()
    await liberar()
  }
  process.exit(codigo)
}

/**
 * Serializa las ejecuciones de la suite contra la misma base.
 *
 * ─── EL BUG QUE ESTO ARREGLA ─────────────────────────────────────────────
 *
 * El teardown borra por VENTANA DE TIEMPO: todo tenant creado desde que
 * arrancó el fichero. Con dos ejecuciones simultáneas contra la misma base,
 * cada una veía los tenants de la otra como suyos y se los llevaba por
 * delante. Resultado: `product-express` fallaba (el producto "no existía")
 * pasando perfectamente en solitario, porque el teardown de OTRA suite había
 * borrado su tenant a mitad de la prueba.
 *
 * Pasó de verdad: lancé dos `npm test` a la vez sin darme cuenta. Y no era un
 * descuido aislado — dos terminales, dos personas o un CI y un portátil lo
 * provocan igual.
 *
 * ─── POR QUÉ UN LOCK Y NO EL ENFOQUE POR PREFIJO O POR ID ────────────────
 *
 * Rastrear los ids creados por cada proceso sería lo preciso, pero los tests
 * crean tenants con `prisma.tenant.create` directo en decenas de sitios, y
 * obligarlos a registrarse es justo el tipo de convención que se olvida —
 * que es como se llegó a 280 tenants de residuo.
 *
 * El lock no exige nada a los tests: cada fichero es exclusivo, y la ventana
 * de tiempo vuelve a ser fiable porque nadie más escribe mientras corre.
 *
 * Es un lock a nivel de SESIÓN en una conexión dedicada, no del pool de
 * Prisma: un lock de sesión sobre una conexión que el pool reparte entre
 * consultas se soltaría —o se heredaría— de forma impredecible. Si el
 * proceso muere, Postgres cierra la conexión y libera el lock solo.
 */
async function tomarLock(): Promise<() => Promise<void>> {
  const { Client } = await import('pg')
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL
  if (!url) return async () => {}

  // Se quita lo que el `pg` crudo no entiende de la cadena de Prisma.
  const conexion = url.replace(/[?&]pgbouncer=true/, '').replace(/[?&]connection_limit=\d+/, '')
  // keepAlive: Neon cierra las conexiones inactivas y esta pasa minutos sin
  // hablar. Sin el manejador de 'error', ese cierre tumbaba TODA la suite con
  // un 'Unhandled error event' que nada tenía que ver con lo que se probaba.
  const cliente = new Client({ connectionString: conexion, keepAlive: true })
  let perdida = false
  cliente.on('error', () => {
    if (!perdida) {
      perdida = true
      console.log('  ⚠ se perdió la conexión del bloqueo de la suite; sigue sin exclusión entre ejecuciones.')
    }
  })
  await cliente.connect()

  const t0 = Date.now()
  const libre = await cliente.query<{ ok: boolean }>(
    'SELECT pg_try_advisory_lock($1) AS ok',
    [LOCK_KEY],
  )
  if (!libre.rows[0]?.ok) {
    console.log('  ⏳ otra ejecución de la suite está usando esta base; esperando turno…')
    await cliente.query('SELECT pg_advisory_lock($1)', [LOCK_KEY])
    console.log(`  ▶ turno conseguido tras ${Math.round((Date.now() - t0) / 1000)} s`)
  }

  return async () => {
    try {
      await cliente.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY])
    } finally {
      await cliente.end().catch(() => {})
    }
  }
}
