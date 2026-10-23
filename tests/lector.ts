import {
  digitoControlGs1, esGs1Valido, formatoDeDetector, lecturaValida,
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

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  process.exit(fail === 0 ? 0 : 1)
}
main()
