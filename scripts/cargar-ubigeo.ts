/**
 * Carga el catálogo de ubigeo del INEI.
 *
 *   npx tsx scripts/cargar-ubigeo.ts <fichero> --departamentos-fuente 25 --provincias-fuente N \
 *       --distritos-fuente N [--fuente "texto"] [--version 2026] [--forzar]
 *
 * Los TRES totales son obligatorios: son las cifras que declara la fuente oficial
 * del INEI (no las de nuestro fichero). Si no coinciden exactamente con lo que
 * trae el fichero, no se carga nada.
 *
 * Acepta CSV o JSON. VALIDA antes de escribir y, si la validación falla, NO
 * CARGA NADA — ni "lo que se pudo". Un catálogo a medias deja unos distritos
 * existentes y otros no, y la causa es invisible desde el selector.
 *
 * ─── FORMATOS ACEPTADOS ──────────────────────────────────────────────────
 *
 * CSV con cabecera, en cualquiera de estas formas (se detectan solas):
 *   codigo,nombre,nivel          → 150101,Lima,3
 *   codigo,nombre               → el nivel se deduce de los ceros del código
 *   codigo,departamento,provincia,distrito → formato "ancho" del INEI
 *
 * JSON: un array de objetos con `codigo`/`nombre` y opcionalmente `nivel`.
 */
import { config } from 'dotenv'
config({ path: '.env.local' })
config({ path: '.env' })

import { readFileSync } from 'node:fs'
import { assertWritableEnvironment } from '../src/lib/env-guard'
import { prisma } from '../src/lib/prisma'
import { validarCatalogoUbigeo, type FilaUbigeo } from '../src/features/ubigeo/validar'
import { leerTotalesDeclarados, opcion } from '../src/features/ubigeo/cargador'
import { detectDelimiter, parseCsv } from '../src/features/inventory/csv'

/** El nivel se deduce de los ceros finales del código. */
function nivelDe(codigo: string): 1 | 2 | 3 {
  if (codigo.endsWith('0000')) return 1
  if (codigo.endsWith('00')) return 2
  return 3
}

function padreDe(codigo: string, nivel: number): string | null {
  if (nivel === 1) return null
  if (nivel === 2) return `${codigo.slice(0, 2)}0000`
  return `${codigo.slice(0, 4)}00`
}

const norm = (s: string) => s.trim().toLowerCase()

function leerJson(texto: string): FilaUbigeo[] {
  const datos = JSON.parse(texto)
  if (!Array.isArray(datos)) throw new Error('El JSON debe ser un array.')
  return datos.map((d: Record<string, unknown>) => {
    const codigo = String(d.codigo ?? d.code ?? d.id_ubigeo ?? d.codigo_ubigeo ?? '').trim()
    const nombre = String(d.nombre ?? d.name ?? d.nombre_ubigeo ?? '').trim()
    const nivel = d.nivel ?? d.nivel_ubigeo
    return {
      codigo,
      nombre,
      nivel: nivel ? (Number(nivel) as 1 | 2 | 3) : nivelDe(codigo),
    }
  })
}

function leerCsv(texto: string): FilaUbigeo[] {
  // `parseCsv` devuelve la cabecera APARTE de las filas: `rows` ya no la
  // incluye. Tratar rows[0] como cabecera descartaría el primer dato.
  const { headers, rows } = parseCsv(texto, detectDelimiter(texto))
  if (rows.length === 0) throw new Error('El CSV no tiene filas de datos.')

  const cabecera = headers.map(norm)
  const iCodigo = cabecera.findIndex((c) => /^(codigo|code|ubigeo|id)/.test(c))
  if (iCodigo === -1) {
    throw new Error(`No encuentro la columna del código. Cabecera: ${cabecera.join(', ')}`)
  }

  const iNombre = cabecera.findIndex((c) => /^(nombre|name|descripcion)/.test(c))
  const iNivel = cabecera.findIndex((c) => /^(nivel|level)/.test(c))
  const iDep = cabecera.findIndex((c) => /^departamento/.test(c))
  const iProv = cabecera.findIndex((c) => /^provincia/.test(c))
  const iDist = cabecera.findIndex((c) => /^distrito/.test(c))

  const filas: FilaUbigeo[] = []
  for (const fila of rows) {
    const codigo = (fila[iCodigo] ?? '').trim()
    if (!codigo) continue
    const nivel = iNivel >= 0 && fila[iNivel] ? (Number(fila[iNivel]) as 1 | 2 | 3) : nivelDe(codigo)

    let nombre = iNombre >= 0 ? (fila[iNombre] ?? '').trim() : ''
    /*
     * Formato "ancho" del INEI: una fila por distrito con las tres columnas.
     * El nombre que toca es el de SU nivel, no el del distrito siempre.
     */
    if (!nombre && iDep >= 0) {
      nombre =
        nivel === 1
          ? (fila[iDep] ?? '').trim()
          : nivel === 2
            ? (fila[iProv] ?? fila[iDep] ?? '').trim()
            : (fila[iDist] ?? fila[iProv] ?? fila[iDep] ?? '').trim()
    }
    filas.push({ codigo, nombre, nivel })
  }
  return filas
}

/**
 * El formato ancho trae una fila por distrito y repite departamento y
 * provincia, así que hay que SINTETIZAR los niveles 1 y 2 que faltan.
 */
function completarNiveles(filas: FilaUbigeo[], crudo: string): FilaUbigeo[] {
  const porCodigo = new Map(filas.map((f) => [f.codigo, f]))
  if (filas.some((f) => f.nivel === 1)) return filas

  console.log('  ℹ No hay filas de nivel 1: parece formato ancho, se sintetizan')
  const { headers, rows } = parseCsv(crudo, detectDelimiter(crudo))
  const cab = headers.map(norm)
  const iCodigo = cab.findIndex((c) => /^(codigo|code|ubigeo|id)/.test(c))
  const iDep = cab.findIndex((c) => /^departamento/.test(c))
  const iProv = cab.findIndex((c) => /^provincia/.test(c))

  for (const fila of rows) {
    const codigo = (fila[iCodigo] ?? '').trim()
    if (!/^\d{6}$/.test(codigo)) continue
    const dep = `${codigo.slice(0, 2)}0000`
    const prov = `${codigo.slice(0, 4)}00`
    if (iDep >= 0 && !porCodigo.has(dep)) {
      const f: FilaUbigeo = { codigo: dep, nombre: (fila[iDep] ?? '').trim(), nivel: 1 }
      porCodigo.set(dep, f)
    }
    if (iProv >= 0 && !porCodigo.has(prov)) {
      const f: FilaUbigeo = { codigo: prov, nombre: (fila[iProv] ?? '').trim(), nivel: 2 }
      porCodigo.set(prov, f)
    }
  }
  return [...porCodigo.values()]
}

async function main() {
  const args = process.argv.slice(2)
  // El valor de una opción no puede confundirse con la ruta del fichero.
  const ruta = args.find((a, i) => !a.startsWith('--') && !(args[i - 1]?.startsWith('--') && args[i - 1] !== '--forzar'))
  const version = opcion(args, '--version') ?? String(new Date().getFullYear())
  const forzar = args.includes('--forzar')

  if (!ruta) {
    console.error(
      'Uso: npx tsx scripts/cargar-ubigeo.ts <fichero.csv|json> --departamentos-fuente 25 ' +
        '--provincias-fuente N --distritos-fuente N [--fuente "texto"] [--version 2026] [--forzar]',
    )
    process.exit(1)
  }

  const declarados = leerTotalesDeclarados(args)
  if (typeof declarados === 'string') {
    console.error(`\n  ✗ ${declarados}\n\n  NO SE CARGÓ NADA.`)
    process.exit(1)
  }
  const fuente = opcion(args, '--fuente')
  if (fuente) console.log(`  fuente declarada: ${fuente}`)
  console.log(`  la fuente declara: ${declarados.departamentos} departamentos, ${declarados.provincias} provincias, ${declarados.distritos} distritos`)

  // El catálogo es global: escribirlo toca a TODOS los tenants, así que pasa
  // por la misma guarda que cualquier script que escriba en la base.
  assertWritableEnvironment({
    script: 'cargar-ubigeo',
    efecto: 'reemplaza la tabla ubigeos (catálogo GLOBAL: afecta a todos los tenants)',
  })

  const texto = readFileSync(ruta, 'utf-8')
  let filas = ruta.endsWith('.json') ? leerJson(texto) : leerCsv(texto)
  if (!ruta.endsWith('.json')) filas = completarNiveles(filas, texto)

  // Se rellena el padre después de tener todas las filas.
  const conPadre = filas.map((f) => ({ ...f, padre: padreDe(f.codigo, f.nivel) }))

  console.log(`\n  fichero: ${ruta}`)
  console.log(`  filas leídas: ${conPadre.length}`)

  const v = validarCatalogoUbigeo(conPadre, declarados)
  console.log(
    `\n  departamentos: ${v.conteo.departamentos}  ` +
      `provincias: ${v.conteo.provincias}  distritos: ${v.conteo.distritos}`,
  )

  if (v.avisos.length > 0) {
    console.log('\n  AVISOS:')
    for (const a of v.avisos) console.log(`    ⚠ ${a}`)
  }

  if (!v.ok) {
    console.log('\n  ERRORES:')
    for (const e of v.errores) console.log(`    ✗ ${e}`)
    console.error(
      '\n  NO SE CARGÓ NADA.\n' +
        '  Un catálogo incompleto es peor que ninguno: con un selector en\n' +
        '  cascada a medias, los distritos que falten serían IMPOSIBLES de\n' +
        '  registrar. Corrige el fichero y vuelve a intentarlo.',
    )
    await prisma.$disconnect()
    process.exit(1)
  }

  console.log('\n  ✓ validación superada')

  const existentes = await prisma.ubigeo.count()
  if (existentes > 0 && !forzar) {
    console.error(
      `\n  Ya hay ${existentes} ubigeos cargados. Usa --forzar para reemplazarlos.`,
    )
    await prisma.$disconnect()
    process.exit(1)
  }

  /*
   * Todo o nada, en una transacción: si el insert se corta a mitad, la tabla
   * se queda con medio catálogo, que es justo lo que la validación evita.
   */
  await prisma.$transaction(
    async (tx) => {
      if (existentes > 0) await tx.ubigeo.deleteMany({})
      const LOTE = 500
      for (let i = 0; i < conPadre.length; i += LOTE) {
        await tx.ubigeo.createMany({
          data: conPadre.slice(i, i + LOTE).map((f) => ({
            codigo: f.codigo,
            nombre: f.nombre,
            nivel: f.nivel,
            padre: f.padre,
            version,
          })),
        })
        process.stdout.write(`\r  cargando… ${Math.min(i + LOTE, conPadre.length)}/${conPadre.length}`)
      }
    },
    { maxWait: 20_000, timeout: 120_000 },
  )

  console.log(`\n\n  ✓ ${await prisma.ubigeo.count()} ubigeos cargados (versión ${version})`)
  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error(`\n  ${e instanceof Error ? e.message : e}`)
  await prisma.$disconnect()
  process.exit(1)
})
