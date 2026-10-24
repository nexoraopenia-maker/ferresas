/**
 * Certificación EMPÍRICA de la nota de crédito contra el proveedor (PSE/OSE) de un negocio de STAGING.
 *
 *   npx tsx scripts/certificar-nota.ts --negocio <slug> --comprobante <F001-00000012>                 # ensayo: no escribe nada
 *   npx tsx scripts/certificar-nota.ts --negocio <slug> --comprobante <F001-00000012> --ejecutar [--motivo 06] [--salida <carpeta>]
 *
 * Qué hace con --ejecutar: emite la nota de crédito TOTAL de ese comprobante con el servicio real
 * (`emitirNotaCreditoTotal`), la hace pasar por la cola fiscal hacia el proveedor que el negocio tiene
 * configurado, y muestra la respuesta tal cual la devolvió. Guarda el XML UBL enviado y un acta con la respuesta.
 * Con eso se decide qué ⚠️ de docs/COMPLIANCE.md §10 se pueden quitar: SOLO lo que el proveedor/SUNAT aceptó.
 *
 * ─── LO QUE NECESITA (y este script no puede inventar) ───────────────────────────────────────────
 *  · Un negocio de STAGING en modo REAL (facturación real habilitada, sin pausa) con su PSE configurado desde la
 *    pantalla de configuración. El script NUNCA pide ni imprime credenciales: lee las del negocio, cifradas.
 *  · Un comprobante REAL ya ACEPTADO por ese mismo proveedor (ambiente de pruebas/homologación). Uno aceptado por el
 *    simulado o de prueba (PB/PF) NO sirve: el proveedor no lo conoce y rechazaría la nota por eso, no por el XML.
 *
 * ─── BARRERAS ────────────────────────────────────────────────────────────────────────────────────
 *  · La guardia de huella (lista blanca de STAGING_DB_FINGERPRINT) y el blindaje de scripts: se niega contra producción.
 *  · PSE_SANDBOX_HOSTS: solo envía si el host del proveedor del negocio está EXACTAMENTE en esa lista (sin ella, nada).
 *  · Sin --ejecutar es un ensayo: comprueba las condiciones y se detiene.
 *  · Una nota emitida es un documento real ante el proveedor: no se borra ni se repite con el mismo motivo
 *    (la segunda sería rechazada por el índice de "una nota total por comprobante").
 */
import { config } from 'dotenv'
config({ path: '.env.local' })
config({ path: '.env' })

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { evaluarEntorno } from './huella-bd'
import { assertWritableEnvironment } from '../src/lib/env-guard'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import type { TenantContext } from '../src/lib/tenant-context'
import { emitirNotaCreditoTotal } from '../src/features/invoicing/service'
import { cargarComprobanteFiscal } from '../src/features/invoicing/envio'
import { construirXmlUbl } from '../src/features/invoicing/ubl'
import { modoFiscal } from '../src/features/invoicing/modo-fiscal'
import { evaluarHostSandbox } from '../src/features/invoicing/sandbox-hosts'
import { reclamarPorId } from '../src/features/cola-fiscal/repositorio'
import { procesarFila } from '../src/features/cola-fiscal/procesar'

function arg(nombre: string): string | undefined {
  const i = process.argv.indexOf(`--${nombre}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const tiene = (nombre: string) => process.argv.includes(`--${nombre}`)
const parar = (m: string): never => { console.error(`✗ ${m}`); process.exit(2) }

async function main() {
  const slug = arg('negocio')
  const numero = arg('comprobante')
  const motivo = arg('motivo') ?? '06'
  const ejecutar = tiene('ejecutar')
  if (!slug || !numero) parar('Uso: --negocio <slug> --comprobante <F001-00000012> [--motivo 01|02|06] [--ejecutar] [--salida <carpeta>]')

  const v = evaluarEntorno()
  if (!v.ok) parar(`Guardia de huella: ${v.motivo}`)
  if (ejecutar) assertWritableEnvironment({ script: 'certificar-nota', efecto: 'emite UNA nota de crédito real y la envía al proveedor del negocio' })

  const tenant = await prisma.tenant.findFirst({ where: { slug, deletedAt: null }, select: { id: true, slug: true, isDemo: true, realBillingEnabledAt: true, realBillingPausedAt: true, pseConfiguredAt: true, pseEndpointUrl: true } })
  if (!tenant) return parar(`No hay un negocio con el slug «${slug}».`)
  const modo = modoFiscal(tenant)
  console.log(`Negocio: ${tenant.slug} · modo fiscal: ${modo} · proveedor configurado: ${tenant.pseConfiguredAt ? 'sí' : 'NO'}`)
  if (modo !== 'REAL') parar(`El negocio está en modo ${modo}: la certificación necesita modo REAL (lo habilita un SuperAdmin tras validar el sandbox).`)
  if (!tenant.pseConfiguredAt || !tenant.pseEndpointUrl) parar('El negocio no tiene su proveedor (PSE) configurado. Se configura desde la pantalla del negocio; este script no maneja credenciales.')

  // Barrera de entorno: solo a un host declarado como SANDBOX (lista exacta). Sin la variable, no se envía nada.
  const sandbox = evaluarHostSandbox(tenant.pseEndpointUrl)
  if (!sandbox.ok) parar(sandbox.motivo)
  console.log(`Proveedor: ${sandbox.motivo}`)

  const dueño = await prisma.user.findFirst({ where: { tenantId: tenant.id, role: 'OWNER', deletedAt: null }, select: { id: true } })
  if (!dueño) return parar('El negocio no tiene un usuario dueño activo.')
  const ctx: TenantContext = { tenantId: tenant.id, userId: dueño.id, role: 'OWNER', access: 'FULL' }
  const db = getTenantPrisma(ctx)

  const original = await db.taxDocument.findFirst({
    where: { fullNumber: numero, documentType: { in: ['BOLETA', 'FACTURA'] } },
    select: { id: true, saleId: true, fullNumber: true, status: true, isTrial: true, externalId: true, responseCode: true },
  })
  if (!original) return parar(`No existe el comprobante ${numero} en ese negocio.`)
  console.log(`Original: ${original.fullNumber} · estado ${original.status} · ${original.isTrial ? 'DE PRUEBA' : 'real'} · id del proveedor: ${original.externalId ?? '—'}`)
  if (original.isTrial) parar('Es un comprobante de prueba (PB/PF): nunca llegó al proveedor.')
  if (original.status !== 'ACEPTADO') parar(`Está ${original.status}: la nota se emite sobre un comprobante ACEPTADO por el proveedor.`)
  if (!original.externalId) parar('El comprobante no tiene identificador del proveedor: lo aceptó el simulado, no un proveedor real. El proveedor no lo conoce.')

  if (!ejecutar) {
    console.log(`\nENSAYO: todo en orden. Con --ejecutar se emitiría la nota de crédito (motivo ${motivo}) sobre ${original.fullNumber} y se enviaría al proveedor.`)
    return
  }

  const sustento = arg('sustento') ?? 'Certificación de la nota de crédito en ambiente de pruebas'
  const nota = await emitirNotaCreditoTotal(db, ctx, { saleId: original.saleId, reasonCode: motivo, reasonDescription: sustento })
  console.log(`\nNota emitida: ${nota.fullNumber} (sobre ${nota.comprobanteOriginal}) · PENDIENTE`)

  // El XML que se manda: el mismo que arma el envío (el proveedor además recibe el comprobante en JSON).
  const { comprobante } = await cargarComprobanteFiscal(db, nota.id)
  const xml = construirXmlUbl(comprobante)
  const carpeta = arg('salida') ?? join('tmp', 'certificacion')
  mkdirSync(carpeta, { recursive: true })
  const base = join(carpeta, `${nota.fullNumber}`)
  writeFileSync(`${base}.xml`, xml)

  // Por la cola, como en producción: reclamo atómico, lease, fencing y reintentos.
  const fila = await reclamarPorId(tenant.id, nota.id, 'certificar-nota', new Date())
  if (!fila) parar('No se pudo reclamar la fila de la cola (¿otro worker la tiene?). Vuelve a mirar el estado de la nota.')
  const resultado = await procesarFila(fila!)
  const despues = await db.taxDocument.findFirstOrThrow({ where: { id: nota.id }, select: { status: true, responseCode: true, statusMessage: true, externalId: true, externalTicket: true, xmlHash: true } })
  const cola = await db.fiscalDispatch.findFirst({ where: { taxDocumentId: nota.id }, select: { status: true, attempts: true, lastError: true } })

  const acta = {
    nota: nota.fullNumber, original: nota.comprobanteOriginal, motivo, resultadoCola: resultado, comprobante: despues, cola,
    fecha: new Date().toISOString(),
  }
  writeFileSync(`${base}.acta.json`, JSON.stringify(acta, null, 2))
  console.log('\n── Respuesta del proveedor ─────────────────────────────')
  console.log(`estado: ${despues.status} · código: ${despues.responseCode ?? '—'}`)
  console.log(`mensaje: ${despues.statusMessage ?? '—'}`)
  console.log(`cola: ${resultado} · fila ${cola?.status} · intentos ${cola?.attempts}${cola?.lastError ? ` · ${cola.lastError}` : ''}`)
  console.log(`XML y acta guardados en ${carpeta}/ (${nota.fullNumber}.xml, ${nota.fullNumber}.acta.json)`)
  if (despues.status === 'ACEPTADO') console.log('\n✓ Aceptada: la estructura UBL y el catálogo 09 (código ' + motivo + ') funcionan con este proveedor. Quita el ⚠️ SOLO de eso.')
  else if (despues.status === 'RECHAZADO') console.log('\n✗ Rechazada: el mensaje de arriba dice qué corregir. NO quites ningún ⚠️.')
  else console.log('\n… Sin respuesta definitiva todavía: la cola seguirá consultando. Vuelve a ejecutar sin --ejecutar para ver el estado.')
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) }).finally(() => prisma.$disconnect())
