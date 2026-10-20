import { validarDocumento } from '@/lib/documentos'
import { BusinessError } from '@/lib/errors'
import type { TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { consultarPadron, type ProveedorPadron } from '@/features/invoicing/padron'

export interface ClientePos {
  id: string
  docType: string
  docNumber: string | null
  name: string
  creado: boolean
  /** De dónde salió el nombre de un cliente nuevo: lo tecleado o el padrón. */
  origen?: 'TECLEADO' | 'PADRON'
}

export interface AvisoPadron { motivo: 'NO_ENCONTRADO' | 'NO_DISPONIBLE'; mensaje: string }

/**
 * Cliente por DNI/RUC desde el mostrador.
 *
 *   1. El documento se valida (largo, prefijo y dígito verificador del RUC):
 *      un RUC mal tecleado se detecta aquí y no cuando SUNAT rechace la factura.
 *   2. Si ya es cliente, se devuelve.
 *   3. Si no, y se tecleó un nombre, se crea con ese nombre.
 *   4. Si no hay nombre, se consulta el padrón: si responde, se crea con el
 *      nombre y la dirección OFICIALES. Si no responde, se devuelve `null` y
 *      un aviso para que la pantalla pida el nombre a mano.
 */
export async function resolverCliente(
  db: TenantPrismaClient,
  ctx: TenantContext,
  entrada: { docNumber: string; name?: string },
  padron?: ProveedorPadron,
): Promise<{ cliente: ClientePos | null; aviso: AvisoPadron | null }> {
  const v = validarDocumento(entrada.docNumber)
  if (!v.valido || !v.tipo) {
    throw new BusinessError('INVALID_DOCUMENT', v.valido ? 'Documento no válido.' : v.mensaje)
  }
  const docType = v.tipo
  const docNumber = entrada.docNumber.trim()

  const existente = await db.customer.findFirst({
    where: { docType, docNumber, deletedAt: null },
    select: { id: true, docType: true, docNumber: true, name: true },
  })
  if (existente) return { cliente: { ...existente, creado: false }, aviso: null }

  let nombre = entrada.name?.trim() || null
  let direccion: string | null = null
  let origen: ClientePos['origen'] = 'TECLEADO'
  let aviso: AvisoPadron | null = null

  if (!nombre) {
    const r = await consultarPadron(docNumber, padron)
    if (r.ok) {
      nombre = r.datos.nombre
      direccion = r.datos.direccion
      origen = 'PADRON'
    } else if (r.motivo !== 'INVALIDO') {
      aviso = { motivo: r.motivo, mensaje: r.mensaje }
    }
  }

  // Sin nombre no se crea: un cliente llamado «20131312955» ensucia el padrón para siempre.
  if (!nombre) return { cliente: null, aviso }

  const nuevo = await db.customer.create({
    data: { tenantId: ctx.tenantId, docType, docNumber, name: nombre, address: direccion },
    select: { id: true, docType: true, docNumber: true, name: true },
  })
  return { cliente: { ...nuevo, creado: true, origen }, aviso: null }
}
