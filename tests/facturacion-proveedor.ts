import './guard'
import { correr } from './teardown'
import {
  obtenerProveedor, proveedoresDisponibles, reiniciarMock,
  type ComprobanteFiscal, type CredencialesProveedor,
} from '@/features/invoicing/providers'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}

const credenciales = (usuario: string): CredencialesProveedor => ({
  usuario, clave: 'secreto', modoPruebas: true,
})

let n = 0
const comprobante = (): ComprobanteFiscal => {
  n += 1
  return {
    tipoComprobante: '03',
    serie: 'B001',
    correlativo: n,
    fechaEmision: '2026-10-17',
    moneda: 'PEN',
    emisor: {
      ruc: '20123456789', razonSocial: 'FERRETERÍA S.A.C.',
      nombreComercial: 'Ferretería Sol', direccion: 'Av. Industrial 123',
      ubigeo: '150101', codigoEstablecimiento: '0000',
    },
    receptor: {
      tipoDocumento: '1', numeroDocumento: '41235678',
      razonSocial: 'María Flores', direccion: null,
    },
    lineas: [{
      numero: 1, descripcion: 'Cemento Sol 42.5 kg', codigoProducto: 'CEM-01',
      unidadMedida: 'NIU', cantidad: 2, precioUnitario: 32.9,
      valorUnitario: 27.88, igv: 10.04, tasaIgv: 0.18,
      tipoAfectacionIgv: '10', importeTotal: 65.8, descuento: 0,
    }],
    totalGravado: 55.76, totalExonerado: 0, totalInafecto: 0,
    totalIgv: 10.04, totalDescuentos: 0, total: 65.8,
    totalEnLetras: 'SON: SESENTA Y CINCO CON 80/100 SOLES',
  }
}

async function main() {
  const p = obtenerProveedor('mock')

  console.log('\n1) Registro de proveedores')
  check('el mock está registrado', proveedoresDisponibles().includes('mock'))
  check('el proveedor expone su nombre', p.nombre === 'mock')
  check('>>> un proveedor inexistente falla CLARO, no en silencio',
    (() => {
      try { obtenerProveedor('inventado'); return false }
      catch (e) { return (e as Error).message.includes('Disponibles') }
    })())

  console.log('\n2) Verificar credenciales ANTES de la primera venta')
  check('credenciales válidas', (await p.verificarCredenciales(credenciales('mock:acepta'))).ok)
  check('credenciales vacías se rechazan',
    !(await p.verificarCredenciales({ usuario: '', clave: '', modoPruebas: true })).ok)
  check('credenciales malas se rechazan con motivo',
    !(await p.verificarCredenciales(credenciales('mock:credencial-mala'))).ok)
  check('informa el vencimiento del certificado',
    (await p.verificarCredenciales(credenciales('mock:acepta'))).certificadoVenceEn !== undefined)

  console.log('\n3) Emisión aceptada')
  reiniciarMock()
  const ok = await p.emitir(comprobante(), credenciales('mock:acepta'))
  check('estado ACEPTADO', ok.estado === 'ACEPTADO')
  check('código de respuesta 0', ok.codigoRespuesta === '0')
  check('devuelve id externo: sin él el comprobante queda huérfano',
    ok.idExterno !== null)
  check('>>> devuelve el hash del XML, que es lo que va en el QR',
    ok.hashXml !== null && ok.hashXml.length > 10)
  check('no se marca como reintentable', !ok.reintentable)

  console.log('\n4) IDEMPOTENCIA: el fallo más caro de una integración fiscal')
  reiniciarMock()
  const c = comprobante()
  const a = await p.emitir(c, credenciales('mock:acepta'))
  const b = await p.emitir(c, credenciales('mock:acepta'))
  check('>>> reemitir (serie, correlativo) devuelve el MISMO comprobante',
    a.idExterno === b.idExterno && a.hashXml === b.hashXml,
    `${a.idExterno} vs ${b.idExterno}`)
  check('no genera un segundo con el mismo correlativo', a.estado === b.estado)

  console.log('\n5) Rechazo DE FONDO: no se debe reintentar')
  reiniciarMock()
  const malo = await p.emitir(comprobante(), credenciales('mock:rechaza'))
  check('estado RECHAZADO', malo.estado === 'RECHAZADO')
  check('>>> marcado NO reintentable: reintentar solo gasta cupo',
    malo.reintentable === false)
  check('el mensaje explica qué corregir',
    (malo.mensaje ?? '').toLowerCase().includes('ruc'))
  check('lleva el código de SUNAT para poder diagnosticar', malo.codigoRespuesta === '2017')

  console.log('\n6) Fallo TRANSITORIO: sí se debe reintentar')
  reiniciarMock()
  const caido = await p.emitir(comprobante(), credenciales('mock:transitorio'))
  check('>>> marcado reintentable', caido.reintentable === true)
  check('queda PENDIENTE, no RECHAZADO: no es culpa del comprobante',
    caido.estado === 'PENDIENTE')
  check('no se le asigna id externo: el proveedor no lo recibió',
    caido.idExterno === null)

  console.log('\n7) Respuesta ASÍNCRONA: ticket y sondeo')
  reiniciarMock()
  const asinc = await p.emitir(comprobante(), credenciales('mock:asincrono'))
  check('estado ENVIADO, no ACEPTADO: todavía no hay CDR', asinc.estado === 'ENVIADO')
  check('devuelve ticket', asinc.ticket !== null)
  const ref = { idExterno: asinc.idExterno, ticket: asinc.ticket, serie: 'B001', correlativo: n }
  const e1 = await p.consultarEstado(ref, credenciales('mock:asincrono'))
  check('>>> la primera consulta responde "en proceso", no un resultado',
    e1.estado === 'ENVIADO', e1.mensaje ?? '')
  const e2 = await p.consultarEstado(ref, credenciales('mock:asincrono'))
  check('la segunda ya trae el CDR', e2.estado === 'ACEPTADO')
  check('con fecha de aceptación', e2.aceptadoEn !== null)

  console.log('\n8) Anulación / comunicación de baja')
  reiniciarMock()
  const paraAnular = comprobante()
  await p.emitir(paraAnular, credenciales('mock:acepta'))
  const baja = await p.anular(
    { idExterno: `mock-B001-${n}`, serie: 'B001', correlativo: n, tipoComprobante: '03' },
    'Error en el documento del cliente',
    credenciales('mock:acepta'),
  )
  check('devuelve ticket de baja', baja.ticket !== null)
  check('estado ANULADO', baja.estado === 'ANULADO')
  check('conserva el motivo', (baja.mensaje ?? '').includes('Error en el documento'))

  reiniciarMock()
  const sinEmitir = await p.anular(
    { idExterno: null, serie: 'B001', correlativo: 999, tipoComprobante: '03' },
    'motivo',
    credenciales('mock:acepta'),
  )
  check('>>> no se anula lo que nunca se emitió', sinEmitir.estado !== 'ANULADO')

  reiniciarMock()
  await p.emitir(comprobante(), credenciales('mock:rechaza'))
  const anularRechazado = await p.anular(
    { idExterno: `mock-B001-${n}`, serie: 'B001', correlativo: n, tipoComprobante: '03' },
    'motivo',
    credenciales('mock:acepta'),
  )
  check('ni lo que fue RECHAZADO: no hay nada que anular',
    anularRechazado.estado !== 'ANULADO', anularRechazado.mensaje ?? '')

  console.log('\n9) Descargas')
  reiniciarMock()
  await p.emitir(comprobante(), credenciales('mock:acepta'))
  const ref2 = { idExterno: `mock-B001-${n}`, serie: 'B001', correlativo: n }
  for (const formato of ['XML', 'CDR', 'PDF'] as const) {
    const d = await p.descargar(ref2, formato, credenciales('mock:acepta'))
    check(`descarga ${formato} con su tipo MIME`,
      d.formato === formato && d.tipoMime.length > 0 && d.contenidoBase64.length > 0,
      d.tipoMime)
  }
  const xml = await p.descargar(ref2, 'XML', credenciales('mock:acepta'))
  check('el contenido viene en base64 decodificable',
    Buffer.from(xml.contenidoBase64, 'base64').toString().includes('XML simulado'))

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
