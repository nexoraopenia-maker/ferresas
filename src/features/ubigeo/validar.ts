/**
 * Validación estructural del catálogo de ubigeo del INEI.
 *
 * ─── POR QUÉ ES FAIL-CLOSED ──────────────────────────────────────────────
 *
 * Un catálogo incompleto es PEOR que ningún catálogo. El dataset público más
 * citado trae 24 códigos de primer nivel cuando el INEI tiene 25 —le falta
 * Callao— y con un selector en cascada basado en él sería IMPOSIBLE registrar
 * una dirección del Callao. El campo de texto libre que hay hoy, con todos
 * sus defectos, al menos deja escribirla.
 *
 * Así que si la validación falla, no se carga NADA. No se carga "lo que se
 * pudo": media carga deja el sistema con unos distritos existentes y otros
 * no, y la causa es invisible desde la UI.
 *
 * ─── POR QUÉ CODIFICACIÓN INEI Y NO RENIEC ───────────────────────────────
 *
 * Son dos sistemas distintos y NO equivalentes para el mismo territorio. Los
 * comprobantes electrónicos de SUNAT piden el ubigeo del INEI. Cargar el de
 * RENIEC pondría un código válido-pero-equivocado en cada factura, y eso no
 * falla en el momento: falla en una fiscalización.
 *
 * Como no hay forma de distinguir los dos sistemas mirando un código suelto,
 * la validación comprueba los ANCLAJES conocidos del INEI (Callao = 07,
 * Lima = 15) y los recuentos oficiales.
 */

export interface FilaUbigeo {
  /** 6 dígitos: departamento(2) + provincia(2) + distrito(2). */
  codigo: string
  nombre: string
  /** 1 departamento, 2 provincia, 3 distrito. */
  nivel: 1 | 2 | 3
}

export interface ResultadoValidacion {
  ok: boolean
  errores: string[]
  avisos: string[]
  conteo: { departamentos: number; provincias: number; distritos: number }
}

/**
 * Anclajes de la codificación INEI.
 *
 * Callao es el que delata un catálogo incompleto: es Provincia
 * Constitucional, no departamento, y por eso los datasets de terceros lo
 * omiten con frecuencia. Si falta el 07, no es el catálogo del INEI.
 */
const ANCLAJES_INEI: Record<string, string> = {
  '04': 'arequipa',
  '07': 'callao',
  '08': 'cusco',
  '13': 'la libertad',
  '15': 'lima',
}

/** El INEI tiene 25 códigos de primer nivel: 24 departamentos + Callao. */
export const DEPARTAMENTOS_INEI = 25

const norm = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim()

export function validarCatalogoUbigeo(
  filas: readonly FilaUbigeo[],
): ResultadoValidacion {
  const errores: string[] = []
  const avisos: string[] = []

  const deps = filas.filter((f) => f.nivel === 1)
  const provs = filas.filter((f) => f.nivel === 2)
  const dists = filas.filter((f) => f.nivel === 3)
  const conteo = {
    departamentos: deps.length,
    provincias: provs.length,
    distritos: dists.length,
  }

  if (filas.length === 0) {
    return { ok: false, errores: ['El catálogo está vacío.'], avisos, conteo }
  }

  // ── 1. Formato: 6 dígitos exactos ───────────────────────────────────────
  const malFormato = filas.filter((f) => !/^\d{6}$/.test(f.codigo))
  if (malFormato.length > 0) {
    errores.push(
      `${malFormato.length} código(s) no son 6 dígitos: ` +
        malFormato.slice(0, 5).map((f) => `"${f.codigo}"`).join(', '),
    )
  }

  // ── 2. Códigos únicos ───────────────────────────────────────────────────
  const vistos = new Set<string>()
  const duplicados = new Set<string>()
  for (const f of filas) {
    if (vistos.has(f.codigo)) duplicados.add(f.codigo)
    vistos.add(f.codigo)
  }
  if (duplicados.size > 0) {
    errores.push(
      `${duplicados.size} código(s) duplicado(s): ${[...duplicados].slice(0, 5).join(', ')}`,
    )
  }

  // ── 3. Exactamente 25 de primer nivel ───────────────────────────────────
  if (conteo.departamentos !== DEPARTAMENTOS_INEI) {
    errores.push(
      `Se esperaban ${DEPARTAMENTOS_INEI} códigos de primer nivel (24 departamentos ` +
        `+ la Provincia Constitucional del Callao) y hay ${conteo.departamentos}. ` +
        'Un catálogo con 24 suele ser uno al que le falta Callao.',
    )
  }

  // ── 4. Los anclajes del INEI, con Callao = 07 ───────────────────────────
  const porCodigo = new Map(filas.map((f) => [f.codigo, f]))
  for (const [prefijo, esperado] of Object.entries(ANCLAJES_INEI)) {
    const codigo = `${prefijo}0000`
    const fila = porCodigo.get(codigo)
    if (!fila) {
      errores.push(
        `Falta el código de primer nivel ${codigo} (${esperado})` +
          (prefijo === '07'
            ? '. Callao = 07 es el anclaje que distingue el catálogo del INEI.'
            : '.'),
      )
      continue
    }
    if (!norm(fila.nombre).includes(esperado)) {
      errores.push(
        `El código ${codigo} debería ser "${esperado}" en la codificación INEI y ` +
          `dice "${fila.nombre}". Puede ser el catálogo de RENIEC, que NO es el que ` +
          'piden los comprobantes de SUNAT.',
      )
    }
  }

  // ── 5. Jerarquía: cada hijo cuelga de un padre que existe ───────────────
  const huerfanos: string[] = []
  for (const p of provs) {
    const padre = `${p.codigo.slice(0, 2)}0000`
    if (!porCodigo.has(padre)) huerfanos.push(`provincia ${p.codigo} → falta ${padre}`)
  }
  for (const d of dists) {
    const padre = `${d.codigo.slice(0, 4)}00`
    if (!porCodigo.has(padre)) huerfanos.push(`distrito ${d.codigo} → falta ${padre}`)
  }
  if (huerfanos.length > 0) {
    errores.push(
      `${huerfanos.length} entrada(s) huérfana(s): ${huerfanos.slice(0, 5).join('; ')}`,
    )
  }

  // ── 6. Coherencia nivel ↔ forma del código ──────────────────────────────
  const nivelIncoherente = filas.filter((f) => {
    if (!/^\d{6}$/.test(f.codigo)) return false
    const esDep = f.codigo.endsWith('0000')
    const esProv = !esDep && f.codigo.endsWith('00')
    const esDist = !esDep && !esProv
    return (
      (f.nivel === 1 && !esDep) ||
      (f.nivel === 2 && !esProv) ||
      (f.nivel === 3 && !esDist)
    )
  })
  if (nivelIncoherente.length > 0) {
    errores.push(
      `${nivelIncoherente.length} entrada(s) con nivel que no cuadra con su código: ` +
        nivelIncoherente.slice(0, 5).map((f) => `${f.codigo} (nivel ${f.nivel})`).join(', '),
    )
  }

  const sinNombre = filas.filter((f) => !f.nombre.trim())
  if (sinNombre.length > 0) {
    errores.push(`${sinNombre.length} entrada(s) sin nombre.`)
  }

  // ── 7. Avisos: no bloquean, pero conviene mirarlos ──────────────────────
  // El INEI ha publicado entre ~1 870 y ~1 890 distritos según el año, así que
  // salirse de ese rango no es forzosamente un error, pero sí algo que mirar.
  if (conteo.distritos > 0 && (conteo.distritos < 1800 || conteo.distritos > 1950)) {
    avisos.push(
      `${conteo.distritos} distritos está fuera del rango esperado (~1 870-1 890). ` +
        'Revisa que sea el catálogo completo y del año que esperas.',
    )
  }
  if (conteo.provincias > 0 && (conteo.provincias < 180 || conteo.provincias > 210)) {
    avisos.push(`${conteo.provincias} provincias está fuera del rango esperado (~196).`)
  }

  return { ok: errores.length === 0, errores, avisos, conteo }
}
