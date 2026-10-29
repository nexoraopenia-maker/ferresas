/**
 * PRUEBA MANUAL contra el ambiente BETA REAL de SUNAT (no corre en la suite). Sirve para liquidar los supuestos de `docs/SUNAT-SUPUESTOS.md`: arma una factura
 * de prueba (UBL 2.1), la firma con tu .pfx, la envía al endpoint BETA (`sendBill`) y muestra el CDR o el error de SUNAT.
 *
 *   npx tsx scripts/probar-sunat-beta-real.ts --dry-run     # arma, firma y verifica en local; NO usa la red
 *   npx tsx scripts/probar-sunat-beta-real.ts               # además la envía al BETA real
 *   npx tsx scripts/probar-sunat-beta-real.ts --sha1        # firma con RSA-SHA1 en vez de SHA-256 (supuesto #5)
 *   npx tsx scripts/probar-sunat-beta-real.ts --caso baja --pausa 6   # segundos mínimos entre llamadas a SUNAT (por defecto 4)
 *   npx tsx scripts/probar-sunat-beta-real.ts --caso todos  # los casos que faltan: credito · boleta · nota-credito · baja · consulta-cdr (o uno solo: --caso boleta)
 *   npx tsx scripts/probar-sunat-beta-real.ts --variantes   # envía varias variantes del XML (la base y experimentos), cada una con su correlativo, y muestra qué dijo SUNAT de cada una
 *   npx tsx scripts/probar-sunat-beta-real.ts --profile-id  # EXPERIMENTAL: añade <cbc:ProfileID schemeID="0101"> (tipo de operación al estilo UBL 2.0) antes de firmar
 *   npx tsx scripts/probar-sunat-beta-real.ts --guardar ./salida-beta   # además guarda el XML firmado y el CDR
 *
 * Lo que garantiza:
 *  · Las credenciales salen SOLO de `.env.local` (nunca de `.env`, que apunta a producción) y se piden con nombres `SUNAT_BETA_*` (ver `.env.example`).
 *  · SOLO habla con el endpoint BETA de SUNAT: la URL está fija en el código y se comprueba contra la lista blanca; no hay manera de apuntarlo a producción.
 *  · NO toca la base de datos. No usa el SUNAT falso.
 *  · No imprime la clave SOL ni la clave del .pfx.
 *
 * ⚠️ Es un envío de PRUEBA a BETA: en BETA SUNAT no da valor tributario a nada. Pero un correlativo repetido con otro contenido se rechaza (por eso, por defecto, el
 * correlativo sale de la hora; puedes fijarlo con SUNAT_BETA_CORRELATIVO).
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { completarRuc, validarRuc } from '../src/lib/documentos'
import { montoALetras } from '../src/lib/numero-a-letras'
import { construirXmlUbl } from '../src/features/invoicing/ubl'
import type { ComprobanteFiscal } from '../src/features/invoicing/providers/types'
import { CertificadoInvalido, estadoCertificado, leerPfx } from '../src/features/sunat/certificado'
import { consultarCdr, consultarTicket, enviarComprobante, enviarResumen, nombreBase, type ResultadoSunat } from '../src/features/sunat/cliente'
import { construirXmlBaja, identificadorDeBaja } from '../src/features/sunat/baja-xml'
import { urlConsulta } from '../src/features/sunat/endpoints'
import { evaluarEndpointSunat, SUNAT_BETA_BILL } from '../src/features/sunat/endpoints'
import { firmarXml, verificarFirmaXml } from '../src/features/sunat/firma'
import { leerCdr } from '../src/features/sunat/cdr'
import { leerZip } from '../src/features/sunat/zip'

const VARIABLES = ['SUNAT_BETA_RUC', 'SUNAT_BETA_USUARIO_SOL', 'SUNAT_BETA_CLAVE_SOL', 'SUNAT_BETA_PFX_RUTA', 'SUNAT_BETA_PFX_CLAVE'] as const

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const sha1 = args.includes('--sha1')
const profileId = args.includes('--profile-id')
const variantes = args.includes('--variantes')
const CASOS = ['credito', 'boleta', 'nota-credito', 'baja', 'consulta-cdr'] as const
type Caso = (typeof CASOS)[number]
const pausaS = args.includes('--pausa') ? Math.max(0, Number(args[args.indexOf('--pausa') + 1]) || 0) : 4
const casoArg = args.includes('--caso') ? args[args.indexOf('--caso') + 1] : undefined
const carpeta = args.includes('--guardar') ? args[args.indexOf('--guardar') + 1] : undefined

/** La última respuesta cruda de SUNAT (la guarda el espía de `fetch`): sirve para diagnosticar cuando la aplicación no la sabe interpretar. */
let ultimaRespuesta = ''
const espia: typeof fetch = async (url, init) => {
  const r = await fetch(url, init)
  ultimaRespuesta = await r.clone().text()
  return r
}

/** Nombres, método y banderas de las entradas de un ZIP leyendo el directorio central (sin validar nada): para ver QUÉ trae SUNAT cuando nuestro lector lo rechaza. */
function entradasDelZip(zip: Buffer): string[] {
  let fin = -1
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65_535); i--) if (zip.readUInt32LE(i) === 0x06054b50) { fin = i; break }
  if (fin < 0) return ['(no se encontró el fin del directorio central: no parece un ZIP)']
  const total = zip.readUInt16LE(fin + 10)
  let p = zip.readUInt32LE(fin + 16)
  const salida: string[] = []
  for (let k = 0; k < total && p + 46 <= zip.length; k++) {
    const ln = zip.readUInt16LE(p + 28), le = zip.readUInt16LE(p + 30), lc = zip.readUInt16LE(p + 32)
    salida.push(`"${zip.subarray(p + 46, p + 46 + ln).toString('utf8')}" · método ${zip.readUInt16LE(p + 10)} · banderas 0x${zip.readUInt16LE(p + 8).toString(16)} · ${zip.readUInt32LE(p + 24)} bytes`)
    p += 46 + ln + le + lc
  }
  return salida
}

function diagnosticar(): void {
  console.log('      ── DIAGNÓSTICO de la respuesta que no se pudo interpretar ──')
  const b64 = /<(?:[\w-]+:)?applicationResponse[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?applicationResponse>/.exec(ultimaRespuesta)?.[1]?.trim()
  if (!b64) {
    console.log(`      la respuesta NO trae applicationResponse. Primeros 600 caracteres:\n${ultimaRespuesta.slice(0, 600)}`)
    return
  }
  const zip = Buffer.from(b64, 'base64')
  console.log(`      applicationResponse: ${b64.length} caracteres base64 → ${zip.length} bytes de ZIP`)
  for (const e of entradasDelZip(zip)) console.log(`      entrada: ${e}`)
  if (carpeta) { mkdirSync(carpeta, { recursive: true }); writeFileSync(`${carpeta}/respuesta-soap.xml`, ultimaRespuesta); writeFileSync(`${carpeta}/cdr-recibido.zip`, zip); console.log(`      guardados ${carpeta}/respuesta-soap.xml y ${carpeta}/cdr-recibido.zip`) }
  try {
    const xml = leerZip(zip).find((e) => e.nombre.toLowerCase().endsWith('.xml'))?.contenido.toString('utf8')
    if (!xml) { console.log('      el ZIP se abrió pero no contiene ningún .xml'); return }
    console.log('      el ZIP se abrió bien; leyendo el CDR…')
    try { const c = leerCdr(xml); console.log(`      CDR leído: código ${c.codigo} · ${c.descripcion}`) } catch (e) { console.log(`      el CDR NO se pudo leer (${e instanceof Error ? e.message : e}). Primeros 800 caracteres:\n${xml.slice(0, 800)}`) }
  } catch (e) { console.log(`      el ZIP NO se pudo abrir: ${e instanceof Error ? `${e.name}: ${e.message}` : e}`) }
}

const paso = (n: number, t: string) => console.log(`\n${n}) ${t}`)
const falla = (m: string): never => { console.error(`\n✖ ${m}`); process.exit(1) }

async function main() {
  if (process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production') falla('Este script no se ejecuta con NODE_ENV/VERCEL_ENV de producción.')

  paso(1, 'Variables de .env.local')
  const faltan = VARIABLES.filter((v) => !process.env[v]?.trim())
  if (faltan.length > 0) falla(`Faltan en .env.local: ${faltan.join(', ')}. Mira .env.example (sección «Prueba manual contra SUNAT BETA»).`)
  const ruc = process.env.SUNAT_BETA_RUC!.trim()
  if (!validarRuc(ruc).valido) falla('SUNAT_BETA_RUC no es un RUC válido (11 dígitos con su dígito verificador).')
  const usuarioSol = process.env.SUNAT_BETA_USUARIO_SOL!.trim()
  const claveSol = process.env.SUNAT_BETA_CLAVE_SOL!
  console.log(`  RUC ${ruc} · usuario SOL ${usuarioSol} · .pfx ${process.env.SUNAT_BETA_PFX_RUTA} · clave SOL y clave del .pfx: cargadas (no se muestran)`)

  paso(2, 'Certificado (.pfx)')
  let cert
  try { cert = leerPfx(readFileSync(resolve(process.env.SUNAT_BETA_PFX_RUTA!.trim())), process.env.SUNAT_BETA_PFX_CLAVE!) } catch (e) {
    falla(e instanceof CertificadoInvalido ? e.message : `No se pudo leer el .pfx: ${e instanceof Error ? e.message : e}`)
  }
  const estado = estadoCertificado(cert!)
  console.log(`  sujeto: ${cert!.sujeto}\n  serie: ${cert!.serie} · vigente hasta ${cert!.vence.toISOString().slice(0, 10)} (${estado}) · RUC detectado en el sujeto: ${cert!.ruc ?? '(no se pudo leer)'}`)
  if (estado === 'vencido' || estado === 'aun_no_vigente') falla(`El certificado no está vigente (${estado}).`)
  if (cert!.ruc && cert!.ruc !== ruc) console.warn(`  ⚠️ El RUC del certificado (${cert!.ruc}) no coincide con SUNAT_BETA_RUC (${ruc}). Si SUNAT BETA acepta cualquier certificado, esto es solo informativo.`)

  // Día de Lima (no UTC): cerca de la medianoche el día de UTC ya es otro.
  const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' })
  const serie = (process.env.SUNAT_BETA_SERIE ?? 'F001').trim().toUpperCase()
  const correlativoBase = Number(process.env.SUNAT_BETA_CORRELATIVO) || (Date.now() % 99_999_999) + 1
  const armar = (correlativo: number, sobre: Partial<ComprobanteFiscal> = {}): ComprobanteFiscal => ({
    tipoComprobante: '01', serie, correlativo, fechaEmision: hoy, moneda: 'PEN',
    emisor: {
      ruc, razonSocial: (process.env.SUNAT_BETA_RAZON_SOCIAL ?? 'EMPRESA DE PRUEBA SAC').trim(), nombreComercial: 'EMPRESA DE PRUEBA',
      direccion: 'AV. LOS CONSTRUCTORES 123', ubigeo: '150101', codigoEstablecimiento: '0000',
    },
    receptor: { tipoDocumento: '6', numeroDocumento: completarRuc('2055555555'), razonSocial: 'CLIENTE DE PRUEBA SAC', direccion: 'AV. LIMA 456' },
    lineas: [{
      numero: 1, descripcion: 'CEMENTO SOL TIPO I 42.5 KG', codigoProducto: 'CEM-001', unidadMedida: 'NIU', cantidad: 1,
      precioUnitario: 11.8, valorUnitario: 10, igv: 1.8, tasaIgv: 0.18, tipoAfectacionIgv: '10', importeTotal: 11.8, descuento: 0,
    }],
    totalGravado: 10, totalExonerado: 0, totalInafecto: 0, totalIgv: 1.8, totalDescuentos: 0, total: 11.8, totalEnLetras: montoALetras(11.8, 'PEN'),
    ...sobre,
  })

  // Variantes EXPERIMENTALES (solo de este script) para averiguar qué le falta al XML cuando SUNAT lo rechaza. `--variantes` las envía todas, cada una con su correlativo.
  type Variante = { nombre: string; transformar: (xml: string) => string }
  const TIPO_OP = /<cbc:InvoiceTypeCode[^>]*>/
  const VARIANTES: Variante[] = [
    { nombre: 'base (el XML que genera la aplicación)', transformar: (x) => x },
    { nombre: 'CONTROL: sin forma de pago', transformar: (x) => x.replace(/<cac:PaymentTerms>[\s\S]*?<\/cac:PaymentTerms>/g, '') },
    { nombre: 'atributos del tipo de operación en el orden de los ejemplos oficiales (sin listSchemeURI)', transformar: (x) => x.replace(TIPO_OP, '<cbc:InvoiceTypeCode listAgencyName="PE:SUNAT" listID="0101" listName="Tipo de Documento" listURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo01" name="Tipo de Operacion">') },
    { nombre: 'espacios de nombres ccts/qdt/udt en la raíz, como los ejemplos oficiales', transformar: (x) => x.replace('<Invoice ', '<Invoice xmlns:ccts="urn:un:unece:uncefact:documentation:2" xmlns:qdt="urn:oasis:names:specification:ubl:schema:xsd:QualifiedDatatypes-2" xmlns:udt="urn:un:unece:uncefact:data:specification:UnqualifiedDataTypesSchemaModule:2" ') },
    { nombre: 'con ProfileID (tipo de operación al estilo UBL 2.0)', transformar: (x) => x.replace('<cbc:CustomizationID>2.0</cbc:CustomizationID>', '<cbc:CustomizationID>2.0</cbc:CustomizationID><cbc:ProfileID schemeName="Tipo de Operacion" schemeAgencyName="PE:SUNAT" schemeURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo51">0101</cbc:ProfileID>') },
  ]

  const intentar = async (correlativo: number, v: Variante, enviar: boolean, etiqueta: string): Promise<number> => {
    const xml = v.transformar(construirXmlUbl(armar(correlativo)))
    const firmado = firmarXml(xml, cert!, { algoritmo: sha1 ? 'sha1' : 'sha256' })
    const verif = verificarFirmaXml(firmado.xmlFirmado)
    console.log(`  [${etiqueta}] ${serie}-${correlativo} · firma local ${verif.valida ? 'VÁLIDA' : 'INVÁLIDA'} · ${v.nombre}`)
    if (!verif.valida) falla('La firma no verifica ni en local: no se envía nada.')
    const base = nombreBase(ruc, '01', serie, correlativo)
    if (carpeta) { mkdirSync(carpeta, { recursive: true }); writeFileSync(`${carpeta}/${base}.xml`, firmado.xmlFirmado) }
    if (!enviar) return 0
    const r = await enviarComprobante(SUNAT_BETA_BILL, { ruc, usuarioSol, claveSol }, base, firmado.xmlFirmado, { timeoutMs: 30_000, env: {}, fetch: espia })
    switch (r.tipo) {
      case 'cdr':
        console.log(`      CDR · categoría ${r.categoria} · código ${r.cdr.codigo} · ${r.cdr.descripcion}${r.cdr.notas.length > 0 ? ` · observaciones: ${r.cdr.notas.join(' | ')}` : ''}`)
        if (carpeta) writeFileSync(`${carpeta}/R-${base}.xml`, r.xmlCdr)
        return r.categoria === 'aceptado' || r.categoria === 'observado' ? 0 : 2
      case 'fallo':
        console.log(`      FALLO SOAP · origen ${r.fallo.origen} · código ${r.fallo.codigo ?? '(sin código)'} · ${r.fallo.mensaje}`)
        return 2
      case 'transitorio':
        console.log(`      Sin respuesta utilizable: ${r.mensaje}`)
        diagnosticar()
        return 3
      case 'ticket':
        console.log(`      SUNAT devolvió un TICKET (${r.ticket}) en vez de un CDR: hallazgo para los supuestos.`)
        return 3
    }
  }


  // ── Casos que faltaban probar (S4/S5 y notas): cada uno firma y envía contra el BETA real y dice qué respondió SUNAT ──
  const resumenCasos: { caso: string; veredicto: string }[] = []
  const describir = (r: ResultadoSunat | { tipo: 'en_proceso' }): { texto: string; ok: boolean } => {
    switch (r.tipo) {
      case 'cdr': return { texto: `CDR · ${r.categoria} · código ${r.cdr.codigo} · ${r.cdr.descripcion}${r.cdr.notas.length ? ` · obs: ${r.cdr.notas.join(' | ')}` : ''}`, ok: r.categoria === 'aceptado' || r.categoria === 'observado' }
      case 'fallo': return { texto: `FALLO SOAP · ${r.fallo.origen} · código ${r.fallo.codigo ?? '(sin código)'} · ${r.fallo.mensaje}`, ok: false }
      case 'ticket': return { texto: `TICKET ${r.ticket}`, ok: true }
      case 'en_proceso': return { texto: 'ticket EN PROCESO (98)', ok: true }
      case 'transitorio': return { texto: `sin respuesta utilizable: ${r.mensaje}`, ok: false }
    }
  }
  const firmarYGuardar = (nombre: string, xml: string) => {
    const f = firmarXml(xml, cert!, { algoritmo: sha1 ? 'sha1' : 'sha256' })
    if (!verificarFirmaXml(f.xmlFirmado).valida) falla('La firma no verifica ni en local: no se envía nada.')
    if (carpeta) { mkdirSync(carpeta, { recursive: true }); writeFileSync(`${carpeta}/${nombre}.xml`, f.xmlFirmado) }
    return f.xmlFirmado
  }
  const SOL = { ruc, usuarioSol, claveSol }
  // Pausa entre llamadas a SUNAT (por defecto 4 s) y, ante un 401/429/5xx sin SOAP (firewall, límite de peticiones o caída pasajera), hasta dos reintentos
  // del MISMO envío con espera creciente: SUNAT reconoce el mismo archivo como el mismo envío, así que reintentar no duplica nada.
  let ultimaLlamada = 0
  const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
  const esperarTurno = async () => {
    const falta = pausaS * 1000 - (Date.now() - ultimaLlamada)
    if (falta > 0) await dormir(falta)
    ultimaLlamada = Date.now()
  }
  const conReintento = async <T extends { tipo: string }>(llamada: () => Promise<T>): Promise<T> => {
    for (let i = 0; ; i++) {
      await esperarTurno()
      const r = await llamada()
      const mensaje = (r as { mensaje?: string }).mensaje ?? ''
      if (r.tipo !== 'transitorio' || !/HTTP (401|429|502|503|504)/.test(mensaje) || i >= 2) return r
      const espera = 15 * (i + 1)
      console.log(`      (${mensaje} — reintento ${i + 1}/2 en ${espera} s)`)
      await dormir(espera * 1000)
    }
  }
  const deps = { timeoutMs: 30_000, env: {}, fetch: espia }
  /** Firma y envía un comprobante por sendBill; en dry-run solo lo arma y firma. */
  const enviarDoc = async (caso: string, tipo: '01' | '03' | '07', serieDoc: string, correlativo: number, comprobante: ComprobanteFiscal): Promise<ResultadoSunat | null> => {
    const base = nombreBase(ruc, tipo, serieDoc, correlativo)
    const xml = firmarYGuardar(base, construirXmlUbl(comprobante))
    if (dryRun) { console.log(`  [${caso}] ${base} · firmado en local, NO enviado`); resumenCasos.push({ caso, veredicto: 'solo en local (--dry-run)' }); return null }
    const r = await conReintento(() => enviarComprobante(SUNAT_BETA_BILL, SOL, base, xml, deps))
    const d = describir(r)
    console.log(`  [${caso}] ${base}\n      ${d.texto}`)
    if (r.tipo === 'cdr' && carpeta) writeFileSync(`${carpeta}/R-${base}.xml`, r.xmlCdr)
    if (r.tipo === 'transitorio') diagnosticar()
    resumenCasos.push({ caso, veredicto: `${d.ok ? '✔' : '✖'} ${d.texto}` })
    return r
  }
  const aceptada = (r: ResultadoSunat | null) => r?.tipo === 'cdr' && (r.categoria === 'aceptado' || r.categoria === 'observado')
  let siguiente = correlativoBase + 100
  /** Una factura de Contado aceptada: la necesitan la nota de crédito, la baja y la consulta de CDR. */
  const facturaBase = async (caso: string): Promise<number | null> => {
    const n = siguiente++
    const r = await enviarDoc(`${caso}/factura de apoyo`, '01', serie, n, armar(n))
    return dryRun || aceptada(r) ? n : null
  }

  const correrCaso = async (caso: Caso) => {
    paso(3, `Caso: ${caso}`)
    if (caso === 'credito') {
      const n = siguiente++
      const vence = new Date(Date.now() + 30 * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'America/Lima' })
      await enviarDoc('credito', '01', serie, n, armar(n, { formaPago: { tipo: 'Credito', monto: 11.8, vence } }))
    } else if (caso === 'boleta') {
      const n = siguiente++
      const serieB = 'B001'
      await enviarDoc('boleta', '03', serieB, n, armar(n, { tipoComprobante: '03', serie: serieB, receptor: { tipoDocumento: '1', numeroDocumento: '41235678', razonSocial: 'CLIENTE VARIOS', direccion: null } }))
    } else if (caso === 'nota-credito') {
      const orig = await facturaBase('nota-credito')
      if (orig === null) { resumenCasos.push({ caso, veredicto: '— no se pudo: la factura de apoyo no fue aceptada' }); return }
      const n = siguiente++
      await enviarDoc('nota-credito', '07', 'FC01', n, armar(n, {
        tipoComprobante: '07', serie: 'FC01',
        documentoRelacionado: { tipoComprobante: '01', serie, correlativo: orig, motivo: '01', descripcionMotivo: 'ANULACION DE LA OPERACION' },
      }))
    } else if (caso === 'consulta-cdr') {
      const orig = await facturaBase('consulta-cdr')
      if (orig === null) { resumenCasos.push({ caso, veredicto: '— no se pudo: la factura de apoyo no fue aceptada' }); return }
      if (dryRun) { console.log('  [consulta-cdr] getStatusCdr no se llama en --dry-run'); return }
      console.log(`  destino de la consulta: ${urlConsulta(SUNAT_BETA_BILL)}`)
      const r = await conReintento(() => consultarCdr(SUNAT_BETA_BILL, SOL, { tipo: '01', serie, numero: orig }, deps))
      const d = describir(r)
      console.log(`  [consulta-cdr] getStatusCdr de ${serie}-${orig}\n      ${d.texto}`)
      if (r.tipo === 'transitorio') diagnosticar()
      resumenCasos.push({ caso: 'consulta-cdr (getStatusCdr)', veredicto: `${d.ok ? '✔' : '✖'} ${d.texto}` })
    } else {
      const orig = await facturaBase('baja')
      if (orig === null) { resumenCasos.push({ caso, veredicto: '— no se pudo: la factura de apoyo no fue aceptada' }); return }
      const seq = (Date.now() % 90_000) + 1
      const dia = hoy
      const identificador = identificadorDeBaja(dia, seq)
      const xml = construirXmlBaja({
        identificador, fechaGeneracion: dia, fechaEmision: dia, emisor: { ruc, razonSocial: (process.env.SUNAT_BETA_RAZON_SOCIAL ?? 'EMPRESA DE PRUEBA SAC').trim() },
        tipoComprobante: '01', serie, correlativo: orig, motivo: 'ERROR EN LA PRUEBA',
      })
      const base = `${ruc}-${identificador}`
      const firmado = firmarYGuardar(base, xml)
      if (dryRun) { console.log(`  [baja] ${base} · firmada en local, NO enviada`); resumenCasos.push({ caso: 'baja', veredicto: 'solo en local (--dry-run)' }); return }
      const env = await conReintento(() => enviarResumen(SUNAT_BETA_BILL, SOL, base, firmado, deps))
      const de = describir(env)
      console.log(`  [baja] sendSummary ${base}\n      ${de.texto}`)
      if (env.tipo !== 'ticket') {
        if (env.tipo === 'transitorio') diagnosticar()
        resumenCasos.push({ caso: 'baja (sendSummary)', veredicto: `✖ ${de.texto}` })
        return
      }
      resumenCasos.push({ caso: 'baja (sendSummary)', veredicto: `✔ ${de.texto}` })
      // getStatus: se pregunta por el ticket hasta que termine (SUNAT puede tardar unos segundos).
      let ultimo: Awaited<ReturnType<typeof consultarTicket>> | null = null
      for (let i = 1; i <= 12; i++) {
        ultimo = await conReintento(() => consultarTicket(SUNAT_BETA_BILL, SOL, env.ticket, deps))
        console.log(`      getStatus intento ${i}: ${describir(ultimo).texto}`)
        if (ultimo.tipo !== 'en_proceso') break
        await dormir(Math.max(5, pausaS) * 1000)
      }
      if (ultimo?.tipo === 'transitorio') diagnosticar()
      if (ultimo?.tipo === 'cdr' && carpeta) writeFileSync(`${carpeta}/R-${base}.xml`, ultimo.xmlCdr)
      const dg = ultimo ? describir(ultimo) : { texto: 'sin consulta', ok: false }
      resumenCasos.push({ caso: 'baja (getStatus)', veredicto: `${dg.ok && ultimo?.tipo !== 'en_proceso' ? '✔' : '✖'} ${dg.texto}` })
    }
  }

  if (casoArg) {
    if (casoArg !== 'todos' && !(CASOS as readonly string[]).includes(casoArg)) falla(`--caso ${casoArg}: usa ${CASOS.join(' · ')} o todos.`)
    if (!dryRun) {
      const v = evaluarEndpointSunat(SUNAT_BETA_BILL, {})
      if (!v.ok || v.tipo !== 'beta') falla(`El destino no es el BETA de SUNAT: ${v.motivo}`)
      console.log(`  destino: ${SUNAT_BETA_BILL} · usuario: ${ruc}${usuarioSol} · pausa mínima entre llamadas: ${pausaS} s`)
    }
    for (const c of casoArg === 'todos' ? CASOS : [casoArg as Caso]) await correrCaso(c)
    paso(4, 'Resumen de los casos')
    for (const r of resumenCasos) console.log(`  ${r.caso.padEnd(30)} ${r.veredicto}`)
    process.exitCode = resumenCasos.some((r) => r.veredicto.startsWith('✖') || r.veredicto.startsWith('—')) ? 2 : 0
    return
  }

  const aEnviar = variantes ? VARIANTES : [profileId ? VARIANTES[4]! : VARIANTES[0]!]
  paso(3, `${aEnviar.length} factura(s) de prueba (UBL 2.1), firmadas con ${sha1 ? 'RSA-SHA1' : 'RSA-SHA256'}${dryRun ? ' — SIN ENVIAR (--dry-run)' : ''}`)
  if (!dryRun) {
    const v = evaluarEndpointSunat(SUNAT_BETA_BILL, {})
    if (!v.ok || v.tipo !== 'beta') falla(`El destino no es el BETA de SUNAT: ${v.motivo}`)
    console.log(`  destino: ${SUNAT_BETA_BILL} · usuario: ${ruc}${usuarioSol}`)
  }
  let salida = 0
  for (const [i, v] of aEnviar.entries()) {
    const codigo = await intentar(correlativoBase + i, v, !dryRun, `${i + 1}/${aEnviar.length}`)
    salida = Math.max(salida, codigo)
  }
  paso(4, dryRun ? 'Resultado' : 'Resultado (código de salida: 0 = SUNAT aceptó todas, 2 = respondió y rechazó alguna, 3 = sin respuesta interpretable)')
  if (dryRun) console.log('✔ --dry-run: todo en orden en local. No se envió nada a SUNAT.')
  else console.log(salida === 0 ? '✔ SUNAT BETA aceptó todo lo enviado.' : '✖ Mira arriba qué variante pasó y cuál no: la diferencia es el hallazgo.')
  process.exitCode = salida
}

main().catch((e) => { console.error('\n✖ Falló:', e instanceof Error ? e.message : e); process.exit(1) })
