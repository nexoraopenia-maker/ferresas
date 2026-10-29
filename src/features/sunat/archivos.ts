import { createHash } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import { BusinessError } from '@/lib/errors'
import { puede } from '@/lib/puede'
import type { TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'

/**
 * Archivos fiscales de un comprobante (S3): el XML firmado tal como se envió a SUNAT y el CDR que SUNAT devolvió. Son la prueba ante SUNAT.
 *
 *  · Se guardan comprimidos (gzip) con el hash (SHA-256) y el tamaño del contenido SIN comprimir.
 *  · Se escriben UNA vez por comprobante y tipo: si ya hay uno NO se reemplaza (la base lo impide con un índice único y un disparador). Reenviar un comprobante que ya
 *    tiene archivos no reescribe lo que SUNAT recibió la primera vez.
 *  · Al leer se vuelve a calcular el hash: un archivo dañado no se entrega como si estuviera bien.
 *  · No hay borrado automático (mínimo 5 años ⚠️ por indicación del dueño, pendiente de la norma).
 */

export type TipoArchivoFiscal = 'XML_FIRMADO' | 'CDR'

export const sha256 = (texto: string) => createHash('sha256').update(texto, 'utf8').digest('hex')

/** Guarda lo que haya (dentro de la transacción `t` que cambia el estado). Idempotente: lo que ya existe no se toca. */
export async function guardarArchivosFiscales(
  t: TenantPrismaClient, tenantId: string, taxDocumentId: string, archivos: { xmlFirmado?: string; cdrXml?: string } | undefined,
): Promise<void> {
  if (!archivos) return
  const filas = ([['XML_FIRMADO', archivos.xmlFirmado], ['CDR', archivos.cdrXml]] as const)
    .filter((f): f is readonly [TipoArchivoFiscal, string] => typeof f[1] === 'string' && f[1].length > 0)
    .map(([kind, texto]) => ({ tenantId, taxDocumentId, kind, content: gzipSync(Buffer.from(texto, 'utf8')), sha256: sha256(texto), size: Buffer.byteLength(texto, 'utf8') }))
  if (filas.length === 0) return
  await t.taxDocumentFile.createMany({ data: filas, skipDuplicates: true })
}

export interface ArchivoFiscal {
  nombre: string
  contenido: string
  sha256: string
}

/** Quién puede descargarlos: quien emite comprobantes o ve reportes (el XML lleva los datos del cliente). */
export async function leerArchivoFiscal(db: TenantPrismaClient, ctx: TenantContext, taxDocumentId: string, kind: TipoArchivoFiscal): Promise<ArchivoFiscal> {
  // Cualquiera de los dos poderes basta (no se exigen los dos a la vez).
  if (!puede(ctx, 'comprobantes.emitir') && !puede(ctx, 'reportes.ver')) throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para descargar los archivos de un comprobante.')
  const f = await db.taxDocumentFile.findFirst({
    where: { taxDocumentId, kind },
    select: { content: true, sha256: true, size: true, taxDocument: { select: { fullNumber: true, isTrial: true } } },
  })
  if (!f) throw new BusinessError('NOT_FOUND', 'Ese comprobante no tiene ese archivo guardado (se guarda cuando SUNAT responde).')
  let contenido: string
  try { contenido = gunzipSync(f.content, { maxOutputLength: 6 * 1024 * 1024 }).toString('utf8') } catch { throw new BusinessError('INVALID_DOCUMENT', 'El archivo guardado está dañado.') }
  if (sha256(contenido) !== f.sha256) throw new BusinessError('INVALID_DOCUMENT', 'El archivo guardado está dañado: su huella no coincide.')
  const n = f.taxDocument.fullNumber
  return { nombre: kind === 'XML_FIRMADO' ? `${n}.xml` : `R-${n}.xml`, contenido, sha256: f.sha256 }
}

/** Qué archivos tiene guardados un comprobante (para mostrar los enlaces de descarga). */
export async function archivosDeComprobante(db: TenantPrismaClient, taxDocumentId: string): Promise<TipoArchivoFiscal[]> {
  const filas = await db.taxDocumentFile.findMany({ where: { taxDocumentId }, select: { kind: true } })
  return filas.map((f) => f.kind)
}
