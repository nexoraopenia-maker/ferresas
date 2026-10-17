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

/** Momento en que arrancó este fichero de pruebas. */
const INICIO = new Date()

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
  }
  process.exit(codigo)
}
