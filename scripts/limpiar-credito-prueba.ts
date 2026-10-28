/**
 * UN SOLO USO · DESTRUCTIVO · pensado para PRODUCCIÓN.
 *
 * Borra negocios de PRUEBA que `tests/credito-esquema.ts` dejó en la base cuando una corrida se interrumpió antes de su limpieza
 * (se reconocen por `cr-<letra>-<6 hex>`, «Crédito <letra>», «Cliente <letra>»). Sus datos no cuadran A PROPÓSITO para el auditor
 * (abonos sin reparto, cuentas sobre ventas sin fiado…): por eso `auditar-credito` los marca como errores.
 *
 * ─── POR QUÉ SE BORRA EL NEGOCIO ENTERO Y NO SOLO SUS CUENTAS Y ABONOS ──
 * Quitar solo cuentas y abonos dejaría clientes con deuda guardada que ya no cuadra y ventas huérfanas: más errores, no menos. Borrar el
 * negocio de prueba completo (como hace la limpieza de las pruebas) deja la base sin esos datos y sin nada que auditar.
 *
 * ─── BARRERAS ────────────────────────────────────────────────────────────
 *  1. Los negocios se nombran UNO A UNO (nada de comodines) y cada slug debe tener exactamente la forma `cr-<letra>-<6 hex>`.
 *  2. Por defecto es SIMULACRO: solo lee y cuenta. Para borrar hace falta `--ejecutar`.
 *  3. Cada negocio debe pasar TODAS las comprobaciones de «esto es una fixture de prueba» (nombre, usuario, clientes, ventas,
 *     sin comprobantes, sin suscripción, sin productos ni movimientos de stock). Si UNO falla, NO se borra NINGUNO.
 *  4. Destino: solo se borra en un destino identificado (staging declarado), o en PRODUCCIÓN a propósito con
 *     `I_UNDERSTAND_THIS_IS_PRODUCTION=true` en la línea de comandos Y escribiendo el nombre de la base como confirmación.
 *  5. Todo en UNA transacción: o se borran todos o ninguno. Después se vuelve a leer para confirmar que no queda nada.
 *
 *   npx tsx scripts/limpiar-credito-prueba.ts cr-a-ed5ea7 cr-b-de92ca                 # simulacro (no escribe nada)
 *   I_UNDERSTAND_THIS_IS_PRODUCTION=true npx tsx scripts/limpiar-credito-prueba.ts cr-a-ed5ea7 cr-b-de92ca --ejecutar
 *
 * Códigos de salida: 0 = hecho / simulacro correcto · 2 = negado por una barrera (no se escribió nada) · 1 = fallo del propio script.
 * HAZ UN BACKUP DE LA BASE ANTES. Después: `npx tsx scripts/auditar-credito.ts` debe dar 0 errores.
 */
import { createInterface } from 'node:readline/promises'
import { config } from 'dotenv'
import { evaluarEntorno, huella } from './huella-bd'

export const PATRON_SLUG = /^cr-([a-z]{1,3})-([0-9a-f]{6})$/

export interface Comprobacion { ok: boolean; texto: string }
export interface InformeNegocio {
  slug: string
  encontrado: boolean
  nombre?: string
  creado?: string
  /** Cuántas filas tiene cada tabla de ese negocio (para que se vea qué se va a borrar). */
  filas: Record<string, number>
  comprobaciones: Comprobacion[]
  /** Pasó TODAS las comprobaciones. Un negocio no encontrado no es «seguro»: simplemente no está. */
  esFixture: boolean
}

/** Lo mínimo del cliente Prisma que usa el script (el cliente base, sin filtro de negocio). */
type Db = typeof import('../src/lib/prisma').prisma

const TABLAS = [
  'user', 'branch', 'warehouse', 'customer', 'sale', 'receivable', 'customerPayment', 'paymentAllocation', 'cashSession',
  'taxDocument', 'subscription', 'product', 'stockMovement',
] as const

export function slugValido(slug: string): boolean { return PATRON_SLUG.test(slug) }

export async function inspeccionar(db: Db, slug: string): Promise<InformeNegocio> {
  const vacio: InformeNegocio = { slug, encontrado: false, filas: {}, comprobaciones: [], esFixture: false }
  const m = PATRON_SLUG.exec(slug)
  if (!m) return { ...vacio, comprobaciones: [{ ok: false, texto: 'El slug no tiene la forma cr-<letra>-<6 hex>.' }] }
  const tag = m[1]!
  const t = await db.tenant.findFirst({ where: { slug }, select: { id: true, name: true, createdAt: true } })
  if (!t) return vacio

  const w = { tenantId: t.id }
  const filas: Record<string, number> = {}
  for (const k of TABLAS) filas[k] = await (db[k] as unknown as { count(a: { where: typeof w }): Promise<number> }).count({ where: w })
  const [usuarios, clientes, ventas] = await Promise.all([
    db.user.findMany({ where: w, select: { email: true } }),
    db.customer.findMany({ where: w, select: { name: true } }),
    db.sale.findMany({ where: w, select: { number: true } }),
  ])

  const c: Comprobacion[] = [
    { ok: t.name === `Crédito ${tag}`, texto: `nombre exactamente «Crédito ${tag}» (es «${t.name}»)` },
    { ok: usuarios.length === 1 && /^o-[0-9a-f-]{36}@x\.com$/.test(usuarios[0]!.email), texto: `un solo usuario, con el correo de prueba o-<uuid>@x.com (hay ${usuarios.length}: ${usuarios.map((u) => u.email).slice(0, 3).join(', ')})` },
    { ok: clientes.every((x) => x.name === `Cliente ${tag}` || x.name === 'x'), texto: `todos los clientes se llaman «Cliente ${tag}» o «x» (hay ${clientes.length})` },
    { ok: ventas.every((v) => new RegExp(`^V-${tag}-[0-9a-f]{6}$`).test(v.number)), texto: `todas las ventas se numeran V-${tag}-<6 hex> (hay ${ventas.length})` },
    { ok: filas.taxDocument === 0, texto: `ningún comprobante electrónico (hay ${filas.taxDocument})` },
    { ok: filas.subscription === 0, texto: `ninguna suscripción (hay ${filas.subscription})` },
    { ok: filas.product === 0 && filas.stockMovement === 0, texto: `ningún producto ni movimiento de stock (hay ${filas.product} y ${filas.stockMovement})` },
  ]
  return { slug, encontrado: true, nombre: t.name, creado: t.createdAt.toISOString(), filas, comprobaciones: c, esFixture: c.every((x) => x.ok) }
}

export interface Resultado {
  /** `simulacro` no escribió; `borrado` borró; `negado` no hizo nada porque una barrera lo impidió. */
  estado: 'simulacro' | 'borrado' | 'negado'
  motivo?: string
  informes: InformeNegocio[]
  borrados: string[]
}

/** El núcleo: inspecciona todos, y solo si TODOS son fixtures y se pidió ejecutar, los borra en una transacción. */
export async function limpiar(db: Db, slugs: readonly string[], opciones: { ejecutar: boolean }): Promise<Resultado> {
  const unicos = [...new Set(slugs)]
  if (unicos.length === 0) return { estado: 'negado', motivo: 'No se indicó ningún negocio.', informes: [], borrados: [] }
  const malos = unicos.filter((s) => !slugValido(s))
  if (malos.length > 0) return { estado: 'negado', motivo: `Slug no válido (debe ser cr-<letra>-<6 hex>): ${malos.join(', ')}`, informes: [], borrados: [] }

  const informes: InformeNegocio[] = []
  for (const s of unicos) informes.push(await inspeccionar(db, s))
  const noSeguros = informes.filter((i) => i.encontrado && !i.esFixture)
  if (noSeguros.length > 0) {
    return { estado: 'negado', motivo: `NO se borra nada: ${noSeguros.map((i) => i.slug).join(', ')} no pasa(n) las comprobaciones de negocio de prueba.`, informes, borrados: [] }
  }
  const presentes = informes.filter((i) => i.encontrado)
  if (!opciones.ejecutar) return { estado: 'simulacro', informes, borrados: [] }
  if (presentes.length === 0) return { estado: 'borrado', motivo: 'No hay nada que borrar (ya no están).', informes, borrados: [] }

  const ids = (await db.tenant.findMany({ where: { slug: { in: presentes.map((i) => i.slug) } }, select: { id: true } })).map((t) => t.id)
  await db.$transaction(async (tx) => {
    // Los comprobantes primero (Restrict sobre la venta). Aquí no hay, pero el orden es el de la limpieza de las pruebas.
    // Las devoluciones (F6.1) apuntan a la venta y a la nota de crédito con Restrict: primero ellas (sus líneas y reembolsos caen en cascada).
    await tx.saleReturn.deleteMany({ where: { tenantId: { in: ids } } })
    await tx.taxDocument.deleteMany({ where: { tenantId: { in: ids } } })
    const r = await tx.tenant.deleteMany({ where: { id: { in: ids } } })
    if (r.count !== ids.length) throw new Error(`Se esperaba borrar ${ids.length} negocio(s) y se borraron ${r.count}: se deshace todo.`)
  }, { timeout: 120_000, maxWait: 30_000 })

  const quedan = await db.tenant.count({ where: { slug: { in: presentes.map((i) => i.slug) } } })
  if (quedan > 0) throw new Error(`Tras borrar siguen existiendo ${quedan} negocio(s). Revisa la base.`)
  return { estado: 'borrado', informes, borrados: presentes.map((i) => i.slug) }
}

// ─── Línea de comandos ──────────────────────────────────────────────────────────────────────────────────────────

function mostrar(i: InformeNegocio): void {
  if (!i.encontrado) { console.log(`\n· ${i.slug}: NO existe en esta base.`); return }
  console.log(`\n▌ ${i.slug} — «${i.nombre}» (creado ${i.creado?.slice(0, 19).replace('T', ' ')})`)
  console.log(`  filas: ${Object.entries(i.filas).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(' · ') || '(ninguna)'}`)
  for (const x of i.comprobaciones) console.log(`  ${x.ok ? '✓' : '✗'} ${x.texto}`)
  console.log(`  ⇒ ${i.esFixture ? 'ES un negocio de prueba (pasa todas las comprobaciones)' : 'NO se reconoce como negocio de prueba'}`)
}

async function main() {
  config({ path: '.env.local' })
  config({ path: '.env' })
  const args = process.argv.slice(2)
  const ejecutar = args.includes('--ejecutar')
  const slugs = args.filter((a) => !a.startsWith('--'))
  const desconocidas = args.filter((a) => a.startsWith('--') && a !== '--ejecutar')
  if (desconocidas.length > 0) { console.error(`Opción desconocida: ${desconocidas.join(', ')}`); process.exit(2) }

  const { prisma } = await import('../src/lib/prisma')
  try {
    const destino = huella(process.env.DATABASE_URL) ?? '(sin DATABASE_URL)'
    const v = evaluarEntorno(process.env)
    console.log(`Destino: ${destino}`)
    console.log(`Modo: ${ejecutar ? 'EJECUTAR (borra)' : 'simulacro (no escribe nada)'}`)

    const r0 = await limpiar(prisma, slugs, { ejecutar: false })
    r0.informes.forEach(mostrar)
    if (r0.estado === 'negado') { console.error(`\n✗ ${r0.motivo}`); process.exitCode = 2; return }
    if (!ejecutar) { console.log('\n(Simulacro: no se escribió nada. Añade --ejecutar para borrar.)'); return }

    // Barrera de destino: staging declarado, o producción a propósito. Cualquier otra cosa no se toca.
    if (!v.ok && !v.contraProduccion) { console.error(`\n✗ No se borra: no se puede identificar el destino. ${v.motivo}`); process.exitCode = 2; return }
    if (v.contraProduccion && process.env.I_UNDERSTAND_THIS_IS_PRODUCTION !== 'true') {
      console.error('\n✗ El destino es PRODUCCIÓN. Para borrar a propósito: I_UNDERSTAND_THIS_IS_PRODUCTION=true en la línea de comandos.'); process.exitCode = 2; return
    }
    const presentes = r0.informes.filter((i) => i.encontrado)
    if (presentes.length === 0) { console.log('\nNo hay nada que borrar: esos negocios ya no están.'); return }

    console.log(`\nVas a BORRAR PARA SIEMPRE ${presentes.length} negocio(s) de ${destino}: ${presentes.map((i) => i.slug).join(', ')}.`)
    console.log('¿Hiciste el backup? Esto no se puede deshacer.')
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    // Si la entrada se cierra sin respuesta (nadie escribió nada), cuenta como NO confirmado: nunca se queda esperando ni sale «bien» en silencio.
    const cerrada = new Promise<string>((resolver) => rl.once('close', () => resolver('')))
    const respuesta = (await Promise.race([rl.question(`Para confirmar escribe el nombre de la base tal cual (${destino}): `), cerrada])).trim()
    rl.close()
    if (respuesta !== destino) { console.error('\n✗ La confirmación no coincide. No se borró nada.'); process.exitCode = 2; return }

    const r = await limpiar(prisma, slugs, { ejecutar: true })
    if (r.estado === 'negado') { console.error(`\n✗ ${r.motivo}`); process.exitCode = 2; return }
    console.log(`\n✓ Borrados: ${r.borrados.join(', ') || '(ninguno)'}. Ahora corre: npx tsx scripts/auditar-credito.ts`)
  } finally {
    await prisma.$disconnect()
  }
}

if (process.argv[1] && /limpiar-credito-prueba\.ts$/.test(process.argv[1])) {
  main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
}
