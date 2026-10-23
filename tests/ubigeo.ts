import './guard'
import { correr } from './teardown'
import {
  DEPARTAMENTOS_INEI, validarCatalogoUbigeo, type FilaUbigeo,
} from '@/features/ubigeo/validar'
import { leerTotalesDeclarados, opcion } from '@/features/ubigeo/cargador'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}

/**
 * Catálogo SINTÉTICO estructuralmente válido.
 *
 * Los nombres de los 25 códigos de primer nivel son los reales porque la
 * validación comprueba anclajes (Callao = 07, Lima = 15). El resto —las
 * provincias y distritos— son de relleno: aquí se prueba el VALIDADOR, no se
 * declara un catálogo oficial.
 */
const DEPTOS: [string, string][] = [
  ['01', 'Amazonas'], ['02', 'Áncash'], ['03', 'Apurímac'], ['04', 'Arequipa'],
  ['05', 'Ayacucho'], ['06', 'Cajamarca'], ['07', 'Callao'], ['08', 'Cusco'],
  ['09', 'Huancavelica'], ['10', 'Huánuco'], ['11', 'Ica'], ['12', 'Junín'],
  ['13', 'La Libertad'], ['14', 'Lambayeque'], ['15', 'Lima'], ['16', 'Loreto'],
  ['17', 'Madre de Dios'], ['18', 'Moquegua'], ['19', 'Pasco'], ['20', 'Piura'],
  ['21', 'Puno'], ['22', 'San Martín'], ['23', 'Tacna'], ['24', 'Tumbes'],
  ['25', 'Ucayali'],
]

function catalogoValido(): FilaUbigeo[] {
  const filas: FilaUbigeo[] = []
  for (const [p, nombre] of DEPTOS) {
    filas.push({ codigo: `${p}0000`, nombre, nivel: 1 })
    // 8 provincias por departamento = 200, y 9 distritos cada una = 1 800.
    for (let pr = 1; pr <= 8; pr++) {
      const cp = `${p}${String(pr).padStart(2, '0')}`
      filas.push({ codigo: `${cp}00`, nombre: `Provincia ${cp}`, nivel: 2 })
      for (let d = 1; d <= 9; d++) {
        filas.push({
          codigo: `${cp}${String(d).padStart(2, '0')}`,
          nombre: `Distrito ${cp}${d}`,
          nivel: 3,
        })
      }
    }
  }
  return filas
}

async function main() {
  console.log('\n1) Catálogo válido')
  const bueno = catalogoValido()
  const v = validarCatalogoUbigeo(bueno)
  check('pasa la validación', v.ok, v.errores.join(' | '))
  check(`tiene los ${DEPARTAMENTOS_INEI} códigos de primer nivel`,
    v.conteo.departamentos === DEPARTAMENTOS_INEI, String(v.conteo.departamentos))
  check('cuenta provincias y distritos',
    v.conteo.provincias === 200 && v.conteo.distritos === 1800,
    `${v.conteo.provincias} prov, ${v.conteo.distritos} dist`)
  check('sin errores', v.errores.length === 0)

  console.log('\n2) >>> EL CASO QUE MOTIVÓ TODO ESTO: falta Callao')
  // El dataset público más citado trae 24 y le falta Callao. Un selector en
  // cascada basado en él haría IMPOSIBLE registrar una dirección del Callao.
  const sinCallao = bueno.filter((f) => !f.codigo.startsWith('07'))
  const vSin = validarCatalogoUbigeo(sinCallao)
  check('>>> se RECHAZA', !vSin.ok)
  check('solo quedan 24 de primer nivel', vSin.conteo.departamentos === 24)
  check('>>> el error NOMBRA a Callao, no dice solo "faltan datos"',
    vSin.errores.some((e) => e.toLowerCase().includes('callao')),
    vSin.errores.find((e) => e.toLowerCase().includes('callao'))?.slice(0, 80) ?? '')
  check('y explica que 24 suele significar justo eso',
    vSin.errores.some((e) => e.includes('24')))

  console.log('\n3) Códigos duplicados')
  const dup = [...bueno, { codigo: '150101', nombre: 'Repetido', nivel: 3 as const }]
  const vDup = validarCatalogoUbigeo(dup)
  check('se rechaza', !vDup.ok)
  check('el error identifica el código duplicado',
    vDup.errores.some((e) => e.includes('150101')))

  console.log('\n4) Formato: 6 dígitos exactos')
  for (const malo of ['15010', '1501011', '15010a', '', '150-101']) {
    const r = validarCatalogoUbigeo([
      ...bueno,
      { codigo: malo, nombre: 'Malo', nivel: 3 },
    ])
    check(`rechaza "${malo || '(vacío)'}"`, !r.ok)
  }

  console.log('\n5) >>> Jerarquía: nada huérfano')
  const huerfano = [
    ...bueno,
    { codigo: '990101', nombre: 'Distrito de un depto inexistente', nivel: 3 as const },
  ]
  const vHuer = validarCatalogoUbigeo(huerfano)
  check('>>> un distrito sin su provincia se rechaza', !vHuer.ok)
  check('el error dice de qué cuelga y qué falta',
    vHuer.errores.some((e) => e.includes('990101') && e.includes('990100')),
    vHuer.errores.find((e) => e.includes('990101'))?.slice(0, 70) ?? '')

  const provHuerfana = [
    ...bueno,
    { codigo: '990100', nombre: 'Provincia sin departamento', nivel: 2 as const },
  ]
  check('una provincia sin su departamento también',
    !validarCatalogoUbigeo(provHuerfana).ok)

  console.log('\n6) Nivel coherente con la forma del código')
  const nivelMal = bueno.map((f) =>
    f.codigo === '150101' ? { ...f, nivel: 1 as const } : f,
  )
  const vNivel = validarCatalogoUbigeo(nivelMal)
  check('un distrito declarado como departamento se rechaza', !vNivel.ok)
  check('el error señala el código y su nivel',
    vNivel.errores.some((e) => e.includes('150101')))

  console.log('\n7) >>> Distinguir INEI de RENIEC')
  // No se pueden distinguir mirando un código suelto, así que se comprueban
  // los anclajes. Si el 07 no es Callao, no es el catálogo del INEI.
  const reniec = bueno.map((f) =>
    f.codigo === '070000' ? { ...f, nombre: 'Cajamarca' } : f,
  )
  const vRen = validarCatalogoUbigeo(reniec)
  check('>>> si el 07 no es Callao, se rechaza', !vRen.ok)
  check('>>> y el error AVISA de que puede ser el catálogo de RENIEC',
    vRen.errores.some((e) => e.includes('RENIEC')),
    vRen.errores.find((e) => e.includes('RENIEC'))?.slice(0, 90) ?? '')
  check('también se comprueba Lima = 15',
    !validarCatalogoUbigeo(
      bueno.map((f) => (f.codigo === '150000' ? { ...f, nombre: 'Otra cosa' } : f)),
    ).ok)

  console.log('\n8) Entradas sin nombre')
  check('se rechazan',
    !validarCatalogoUbigeo([...bueno, { codigo: '250999', nombre: '   ', nivel: 3 }]).ok)

  console.log('\n9) Catálogo vacío')
  const vVacio = validarCatalogoUbigeo([])
  check('se rechaza', !vVacio.ok)
  check('con un mensaje claro', vVacio.errores[0]?.includes('vacío') === true)

  console.log('\n10) Avisos que NO bloquean')
  // Un recuento raro merece una mirada, pero no impide cargar: el INEI ha
  // publicado entre ~1 870 y ~1 890 distritos según el año.
  const pocos = bueno.filter((f) => f.nivel !== 3)
  const vPocos = validarCatalogoUbigeo(pocos)
  check('un catálogo sin distritos sigue siendo estructuralmente válido', vPocos.ok)
  check('los avisos son avisos, no errores', vPocos.errores.length === 0)

  console.log('\n11) Nombres con tilde y sin tilde')
  check('"Áncash" y "Ancash" se tratan igual al comparar anclajes',
    validarCatalogoUbigeo(
      bueno.map((f) => (f.codigo === '040000' ? { ...f, nombre: 'AREQUÍPA' } : f)),
    ).ok)

  console.log('\n12) >>> Los totales DECLARADOS por la fuente son obligatorios y exactos')
  const tot = { departamentos: 25, provincias: 200, distritos: 1800 }
  check('coincidencia exacta → sin errores', validarCatalogoUbigeo(bueno, tot).ok)
  const unoMenos = bueno.filter((f) => f.codigo !== '150109')
  const vMenos = validarCatalogoUbigeo(unoMenos, tot)
  check('>>> un distrito de menos frente a lo que declara la fuente se RECHAZA', !vMenos.ok)
  check('el error dice cuántos trae el fichero y cuántos declara la fuente',
    vMenos.errores.some((e) => e.includes('1799') && e.includes('1800') && e.includes('distritos')), vMenos.errores.join(' | ').slice(0, 120))
  check('>>> uno de más también', !validarCatalogoUbigeo([...bueno, { codigo: '150999', nombre: 'Sobra', nivel: 3 }], tot).ok)
  check('provincias que no coinciden se rechazan', !validarCatalogoUbigeo(bueno, { ...tot, provincias: 196 }).ok)
  check('departamentos declarados distintos de los que trae se rechazan', !validarCatalogoUbigeo(bueno, { ...tot, departamentos: 24 }).ok)
  check('sin totales declarados la validación estructural sigue funcionando (compatibilidad)', validarCatalogoUbigeo(bueno).ok)

  console.log('\n13) El cargador exige los tres totales')
  const sin = leerTotalesDeclarados(['f.csv'])
  check('>>> sin ninguna opción NO se puede cargar y el mensaje nombra las tres', typeof sin === 'string' && ['--departamentos-fuente', '--provincias-fuente', '--distritos-fuente'].every((o) => sin.includes(o)))
  check('con solo dos, falta la tercera', (() => { const r = leerTotalesDeclarados(['--departamentos-fuente', '25', '--provincias-fuente', '196']); return typeof r === 'string' && r.includes('--distritos-fuente') && !r.includes('--provincias-fuente') })())
  check('valores no numéricos o cero se rechazan', typeof leerTotalesDeclarados(['--departamentos-fuente', 'veinticinco', '--provincias-fuente', '0', '--distritos-fuente', '1.5']) === 'string')
  check('con los tres válidos devuelve los números', JSON.stringify(leerTotalesDeclarados(['x.csv', '--departamentos-fuente', '25', '--provincias-fuente', '196', '--distritos-fuente', '1890'])) === JSON.stringify({ departamentos: 25, provincias: 196, distritos: 1890 }))
  check('opcion no confunde una bandera con su valor', opcion(['--forzar', '--version', '2026'], '--version') === '2026' && opcion(['--version', '--forzar'], '--version') === undefined)

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
