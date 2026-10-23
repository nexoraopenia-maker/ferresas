import { abrir, ficheros, proyecto, rel } from './ast'
import { join } from 'node:path'
import { RAIZ } from './ast'
import { SyntaxKind } from 'ts-morph'
import {
  esRepeticion, digitoControlGs1, esGs1Valido, formatoDeDetector, lecturaValida,
} from '../src/lib/codigos-barras'
import {
  iniciarLector, RESTRICCIONES_CAMARA,
  type DetectorCtor, type EntornoLector, type ZxingLike,
} from '../src/lib/lector-camara'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  console.log('\n1) Dígito de control GS1 (EAN-13 / EAN-8 / UPC-A)')
  check('EAN-13 reales válidos', ['4006381333931', '5901234123457', '7501031311309'].every((c) => esGs1Valido(c, 13)))
  check('EAN-8 y UPC-A reales válidos', esGs1Valido('96385074', 8) && esGs1Valido('036000291452', 12))
  check('>>> un dígito leído mal se descarta', !esGs1Valido('4006381333932', 13) && !esGs1Valido('4006381333831', 13))
  check('largo o caracteres incorrectos no valen', !esGs1Valido('400638133393', 13) && !esGs1Valido('40063813339A1', 13))
  check('digitoControlGs1 calcula el último dígito', digitoControlGs1('400638133393') === 1)
  check('lecturaValida valida solo los formatos con dígito de control',
    !lecturaValida('4006381333932', 'ean_13') && lecturaValida('4006381333931', 'ean_13')
    && lecturaValida('INT-00123', 'code_128') && lecturaValida('https://x.pe/p/1', 'qr_code'))
  check('>>> un código interno numérico de 13 dígitos en Code128 NO se valida como EAN', lecturaValida('1234567890123', 'code_128'))
  check('vacío no vale', !lecturaValida('  ', 'code_128'))
  check('formatoDeDetector', formatoDeDetector('EAN_13') === 'ean_13' && formatoDeDetector('data_matrix') === 'otro')
  check('la cámara pide la trasera, sin audio y con resolución alta',
    JSON.stringify(RESTRICCIONES_CAMARA).includes('"environment"') && RESTRICCIONES_CAMARA.audio === false)

  console.log('\n2) Lector NATIVO con cámara y detector simulados')
  const aplicadas: unknown[] = []
  let paradas = 0
  const track = {
    getCapabilities: () => ({ focusMode: ['manual', 'continuous'], torch: true }),
    applyConstraints: async (c: unknown) => { aplicadas.push(c) },
    stop: () => { paradas++ },
  }
  const stream = { getVideoTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream
  const video = { readyState: 4, srcObject: null as unknown, play: async () => {} } as unknown as HTMLVideoElement
  let frame = 0
  const guion = [
    [{ rawValue: '4006381333932', format: 'ean_13' }],   // dígito de control malo
    [],                                                   // frame sin código
    [{ rawValue: '4006381333931', format: 'ean_13' }],   // bueno
    [{ rawValue: 'INT-77', format: 'code_128' }],        // interno
  ]
  const Detector = class {
    static getSupportedFormats = async () => ['ean_13', 'ean_8', 'code_128', 'qr_code', 'aztec']
    static creadoCon: unknown
    constructor(op?: unknown) { Detector.creadoCon = op }
    async detect() { return guion[Math.min(frame++, guion.length - 1)]! }
  }
  const leidos: string[] = []
  const env: EntornoLector = {
    getUserMedia: async () => stream,
    BarcodeDetector: Detector as unknown as DetectorCtor,
    cargarZxing: async () => { throw new Error('no debería cargarse') },
  }
  const lector = await iniciarLector({ video, onCodigo: (c) => leidos.push(c), intervaloMs: 5, entorno: env })
  await esperar(80)
  check('>>> usa el motor nativo cuando existe', lector.motor === 'nativo')
  check('solo pide los formatos que el navegador soporta (sin aztec)',
    JSON.stringify((Detector.creadoCon as { formats: string[] }).formats) === JSON.stringify(['ean_13', 'ean_8', 'code_128', 'qr_code']))
  check('>>> descarta la lectura con dígito de control malo', !leidos.includes('4006381333932'))
  check('acepta la buena y la interna', leidos.includes('4006381333931') && leidos.includes('INT-77'))
  check('conecta el video a la cámara', (video as unknown as { srcObject: unknown }).srcObject === stream)
  check('activa el enfoque continuo', JSON.stringify(aplicadas).includes('continuous'))
  check('declara linterna y la enciende', typeof lector.switchTorch === 'function'
    && (await lector.switchTorch!(true), JSON.stringify(aplicadas).includes('"torch":true')))
  const antes = frame
  lector.stop()
  await esperar(40)
  check('>>> stop apaga la cámara, suelta el video y detiene el bucle',
    paradas === 1 && (video as unknown as { srcObject: unknown }).srcObject === null && frame <= antes + 1)

  console.log('\n3) Respaldo ZXing')
  let zxingUsado = 0
  const zx: ZxingLike = async (_v, onCodigo) => { zxingUsado++; onCodigo('4006381333931', 'ean_13'); return { stop() {} } }
  const lecturasZx: string[] = []
  const sinNativo = await iniciarLector({
    video, onCodigo: (c) => lecturasZx.push(c),
    entorno: { getUserMedia: async () => stream, cargarZxing: async () => zx },
  })
  check('>>> sin BarcodeDetector (iOS, Firefox) cae a ZXing', sinNativo.motor === 'zxing' && zxingUsado === 1 && lecturasZx.length === 1)
  const sinEan = await iniciarLector({
    video, onCodigo: () => {},
    entorno: {
      getUserMedia: async () => stream,
      BarcodeDetector: class { static getSupportedFormats = async () => ['qr_code']; async detect() { return [] } } as unknown as DetectorCtor,
      cargarZxing: async () => zx,
    },
  })
  check('>>> con BarcodeDetector sin EAN-13 también usa ZXing', sinEan.motor === 'zxing')
  const falla = await iniciarLector({
    video, onCodigo: () => {},
    entorno: {
      getUserMedia: async () => stream,
      BarcodeDetector: class { static getSupportedFormats = async () => { throw new Error('x') }; async detect() { return [] } } as unknown as DetectorCtor,
      cargarZxing: async () => zx,
    },
  })
  check('si getSupportedFormats falla, usa ZXing', falla.motor === 'zxing')
  let sinEnfoque = 0
  const trackSimple = { getCapabilities: () => ({}), applyConstraints: async () => { sinEnfoque++ }, stop() {} }
  const l2 = await iniciarLector({
    video, onCodigo: () => {}, intervaloMs: 5,
    entorno: {
      getUserMedia: async () => ({ getVideoTracks: () => [trackSimple], getTracks: () => [trackSimple] }) as unknown as MediaStream,
      BarcodeDetector: Detector as unknown as DetectorCtor,
    },
  })
  check('sin enfoque ni linterna declarados no los fuerza', sinEnfoque === 0 && l2.switchTorch === undefined)
  l2.stop()
  let permiso = ''
  try {
    await iniciarLector({
      video, onCodigo: () => {},
      entorno: {
        getUserMedia: async () => { throw Object.assign(new Error('d'), { name: 'NotAllowedError' }) },
        BarcodeDetector: Detector as unknown as DetectorCtor,
      },
    })
  } catch (e) { permiso = (e as Error).name }
  check('>>> el error de permiso llega intacto al modal (NotAllowedError)', permiso === 'NotAllowedError')

  console.log('\n4) Anti-rebote: sostener un código no suma otra unidad')
  const ult = { code: 'A', seen: 1000 }
  check('la misma lectura enseguida es repetición', esRepeticion(ult, 'A', 1100, 1500))
  check('>>> cada avistamiento renueva la ventana (sostenido 5 s = una sola unidad)',
    [1200, 1300, 2000, 3000, 4000, 5000, 6000].every((t) => esRepeticion(ult, 'A', t, 1500)))
  check('>>> tras apartarlo más de la ventana, vuelve a contar', !esRepeticion(ult, 'A', 6000 + 1600, 1500))
  check('otro código nunca es repetición', !esRepeticion({ code: 'A', seen: 1000 }, 'B', 1001, 1500))
  check('sin lectura previa no es repetición', !esRepeticion(null, 'A', 5, 1500))

  console.log('\n5) ESTRUCTURA: la cámara no se reinicia cuando el padre re-renderiza')
  const sf = abrir(proyecto(), 'src/components/inventory/InventoryScannerModal.tsx')
  const llamadas = sf.getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((c) => ['useEffect', 'useCallback'].includes(c.getExpression().getText()))
  const deps = llamadas.map((c) => {
    const arr = c.getArguments()[1]
    return { fn: c.getExpression().getText(), cuerpo: c.getArguments()[0]!.getText(), ids: arr ? arr.getDescendantsOfKind(SyntaxKind.Identifier).map((i) => i.getText()) : null }
  })
  const prohibidas = ['onClose', 'onDetected', 'continuous', 'dedupeMs']
  check('>>> ningún efecto ni callback depende de las props del padre (se leen por ref)',
    deps.every((d) => !d.ids || d.ids.every((n) => !prohibidas.includes(n))), JSON.stringify(deps.map((d) => d.ids)))
  const efectoCamara = deps.find((d) => d.cuerpo.includes('iniciarLector'))
  check('el efecto de la cámara solo depende de open + callbacks estables', !!efectoCamara
    && efectoCamara.ids!.every((n) => ['open', 'handleCode', 'stop'].includes(n)))
  const handle = deps.find((d) => d.cuerpo.includes('esRepeticion'))
  check('handleCode es estable (deps vacías)', !!handle && handle.ids!.length === 0)
  check('hay barrera de errores alrededor del escáner', sf.getFullText().includes('getDerivedStateFromError'))

  console.log('\n6) ESTRUCTURA: quien usa el escáner no pasa un onClose con estado capturado')
  console.log('   (causa del bug de Inventario: onClose veía `phase` viejo y pisaba la hoja del producto)')
  const usuarios = ficheros(join(RAIZ, 'src'), (p) => p.endsWith('.tsx'))
    .filter((f) => rel(f) !== 'src/components/inventory/InventoryScannerModal.tsx')
  const proj = proyecto()
  let cuantos = 0
  for (const f of usuarios) {
    const u = proj.addSourceFileAtPath(f)
    for (const el of u.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement)
      .filter((e) => e.getTagNameNode().getText() === 'InventoryScannerModal')) {
      cuantos++
      const attr = el.getAttribute('onClose')
      const expr = attr?.getFirstDescendantByKind(SyntaxKind.JsxExpression)?.getExpression()
      // Variables de estado del componente que lo contiene: const [x, setX] = useState(...)
      const comp = el.getFirstAncestor((a) => a.getKind() === SyntaxKind.FunctionDeclaration || a.getKind() === SyntaxKind.ArrowFunction)
      const estado = new Set(
        (comp?.getDescendantsOfKind(SyntaxKind.VariableDeclaration) ?? [])
          .filter((v) => /useState/.test(v.getInitializer()?.getText() ?? ''))
          .flatMap((v) => v.getDescendantsOfKind(SyntaxKind.ArrayBindingPattern).flatMap((b) => b.getElements().slice(0, 1).map((e) => e.getText()))),
      )
      const leidas = (expr?.getDescendantsOfKind(SyntaxKind.Identifier) ?? [])
        .filter((i) => estado.has(i.getText()) && i.getParent()?.getKind() !== SyntaxKind.PropertyAccessExpression || (estado.has(i.getText()) && (i.getParent() as { getExpression?: () => unknown })?.getExpression?.() === i))
        .map((i) => i.getText())
      check(`>>> ${rel(f)}: onClose no lee estado capturado (${[...estado].join(', ') || 'sin estado'})`, !!attr && leidas.length === 0, leidas.join(','))
    }
  }
  check('se revisó al menos un uso del escáner', cuantos >= 2, String(cuantos))

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  process.exit(fail === 0 ? 0 : 1)
}
main()
