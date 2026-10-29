import { diaLocal } from '@/lib/periodos'
import { getTenantPrisma, type TenantPrismaClient } from '@/lib/tenant-prisma'
import { elegirProveedor, type DependenciasEnvio } from '@/features/invoicing/envio'
import { tipoComprobante } from '@/features/invoicing/catalogos'
import { modoFiscal } from '@/features/invoicing/modo-fiscal'
import { guardarArchivosBaja } from '@/features/sunat/archivos'
import { dentroDelPlazoDeBaja, PLAZO_BAJA_DIAS } from '@/features/sunat/plazos'
import type { BajaReclamada } from './repositorio'
import { contextoDeSistema, type ResultadoFila } from './procesar'
import { proximoIntento, recortarError } from './reglas'

/**
 * Procesa UNA comunicación de baja ya reclamada: la envía (no tiene ticket) o consulta su ticket (ya lo tiene), con el cliente acotado a SU negocio.
 *
 * Reglas:
 *  · Todo cierre exige seguir siendo el dueño del lease (`lockedBy`): un worker lento cuyo lease se reasignó no pisa el resultado del nuevo.
 *  · El estado del COMPROBANTE solo cambia cuando SUNAT acepta la baja (su CDR), en la MISMA transacción que guarda el CDR. Cualquier otra cosa lo deja como estaba.
 *  · Sin respuesta utilizable (red, 5xx, ticket aún en proceso) NO es un rechazo: se reprograma con la rampa de la cola y, agotada, queda AGOTADA (no «rechazada»).
 *  · El plazo se vuelve a comprobar ANTES del primer envío (la cola pudo tardar): vencido, se cierra como rechazada sin llamar a SUNAT.
 */

const ESPERA_CONSULTA_S = 60
const ESPERA_LIBERACION_S = 60

export async function procesarBaja(fila: BajaReclamada, deps: DependenciasEnvio = {}, ahora: Date = new Date()): Promise<ResultadoFila> {
  const db = getTenantPrisma(contextoDeSistema(fila.tenantId))
  const en = (s: number) => new Date(ahora.getTime() + s * 1000)
  const mio = { id: fila.id, lockedBy: fila.lockedBy, status: { in: ['PENDIENTE', 'ENVIADA'] as ('PENDIENTE' | 'ENVIADA')[] } }
  const sinLease = { lockedUntil: null, lockedBy: null }

  const t = await db.tenant.findFirst({ select: { isDemo: true, realBillingEnabledAt: true, realBillingPausedAt: true, taxId: true, legalName: true, name: true, timezone: true } })
  const liberar = async (motivo: string | null): Promise<ResultadoFila> => {
    // No era el momento (negocio pausado, o sin RUC): no se gasta el intento.
    const r = await db.taxVoid.updateMany({ where: mio, data: { attempts: Math.max(0, fila.attempts - 1), nextAttemptAt: en(ESPERA_LIBERACION_S), ...sinLease, ...(motivo ? { lastError: recortarError(motivo) } : {}) } })
    return r.count === 1 ? 'liberado' : 'perdido'
  }
  if (!t || modoFiscal(t) !== 'REAL') return liberar(null)

  const v = await db.taxVoid.findFirst({
    where: { id: fila.id },
    select: {
      id: true, status: true, identifier: true, issueDay: true, reason: true, ticket: true,
      taxDocument: { select: { id: true, status: true, documentType: true, series: true, correlativo: true, issuedAt: true, isTrial: true } },
    },
  })
  if (!v || (v.status !== 'PENDIENTE' && v.status !== 'ENVIADA')) return 'perdido'
  // Defensa en profundidad: el reclamo ya los excluye, pero un documento de prueba JAMÁS llega a SUNAT.
  if (v.taxDocument.isTrial) return cerrarSinSunat(db, fila, mio, 'Documento de prueba: no se comunica.', ahora)

  const reintentar = async (motivo: string): Promise<ResultadoFila> => {
    const s = proximoIntento(fila.attempts, ahora)
    if (s.agotado) {
      const r = await db.taxVoid.updateMany({ where: mio, data: { status: 'AGOTADA', exhaustedAt: ahora, lastError: recortarError(motivo), ...sinLease } })
      if (r.count !== 1) return 'perdido'
      await db.auditLog.create({
        data: { tenantId: fila.tenantId, action: 'baja.agotada', entityType: 'TaxDocument', entityId: v.taxDocument.id, after: { motivo: recortarError(motivo), nota: 'Sin respuesta de SUNAT tras todos los reintentos: el comprobante sigue como estaba.' } },
      })
      return 'agotado'
    }
    const r = await db.taxVoid.updateMany({ where: mio, data: { nextAttemptAt: s.en, lastError: recortarError(motivo), ...sinLease } })
    return r.count === 1 ? 'reintento' : 'perdido'
  }

  try {
    if (!v.ticket) {
      // ── Primera mitad: enviar ──
      const estaVigente = v.taxDocument.status === 'ACEPTADO' || v.taxDocument.status === 'OBSERVADO'
      if (!estaVigente) return cerrarSinSunat(db, fila, mio, `El comprobante ya no está aceptado (${v.taxDocument.status.toLowerCase()}): no se comunica la baja.`, ahora, v.taxDocument.id)
      const diaEmision = diaLocal(t.timezone, v.taxDocument.issuedAt)
      if (!dentroDelPlazoDeBaja(diaEmision, diaLocal(t.timezone, ahora))) {
        return cerrarSinSunat(db, fila, mio, `Venció el plazo de ${PLAZO_BAJA_DIAS} días antes de que la baja pudiera enviarse. Corrige el comprobante con una nota de crédito.`, ahora, v.taxDocument.id)
      }
      const tipo = tipoComprobante(v.taxDocument.documentType)
      if (!t.taxId || (tipo !== '01' && tipo !== '07' && tipo !== '08')) return cerrarSinSunat(db, fila, mio, 'Este comprobante no admite comunicación de baja.', ahora, v.taxDocument.id)

      const { proveedor, credenciales } = await elegirProveedor(db, fila.tenantId, deps)
      const r = await proveedor.comunicarBaja({
        identificador: v.identifier, fechaGeneracion: v.issueDay, fechaEmision: diaEmision,
        emisor: { ruc: t.taxId, razonSocial: t.legalName ?? t.name },
        tipoComprobante: tipo, serie: v.taxDocument.series, correlativo: v.taxDocument.correlativo, motivo: v.reason,
      }, credenciales)

      if (r.tipo === 'transitorio') return reintentar(r.mensaje)
      if (r.tipo === 'rechazo') {
        return resolver(db, fila, mio, v.taxDocument.id, ahora, { estado: 'RECHAZADA', codigo: r.codigo, mensaje: r.mensaje, archivos: { xmlFirmado: r.xmlFirmado } })
      }
      // Recibida: se guarda el ticket y el XML tal como se envió, y pasa a CONSULTAR con intentos nuevos.
      const ok = await db.$transaction(async (tx) => {
        const x = tx as unknown as TenantPrismaClient
        const c = await x.taxVoid.updateMany({
          where: { ...mio, ticket: null },
          data: { status: 'ENVIADA', ticket: r.ticket, sentAt: ahora, attempts: 0, nextAttemptAt: en(ESPERA_CONSULTA_S), lastError: null, responseMessage: 'Recibida por SUNAT; falta su constancia.', ...sinLease },
        })
        if (c.count !== 1) return false
        await guardarArchivosBaja(x, fila.tenantId, fila.id, { xmlFirmado: r.xmlFirmado })
        await x.auditLog.create({
          data: { tenantId: fila.tenantId, action: 'baja.enviada', entityType: 'TaxDocument', entityId: v.taxDocument.id, after: { identificador: v.identifier, ticket: r.ticket } },
        })
        return true
      })
      return ok ? 'consulta' : 'perdido'
    }

    // ── Segunda mitad: preguntar por el ticket ──
    if (!t.taxId) return liberar('Falta el RUC del negocio.')
    const { proveedor, credenciales } = await elegirProveedor(db, fila.tenantId, deps)
    const c = await proveedor.consultarBaja(v.ticket, t.taxId, credenciales)
    if (c.tipo === 'en_proceso') return reintentar('SUNAT aún está procesando la baja.')
    if (c.tipo === 'transitorio') return reintentar(c.mensaje)
    return resolver(db, fila, mio, v.taxDocument.id, ahora, { estado: c.aceptada ? 'ACEPTADA' : 'RECHAZADA', codigo: c.codigo, mensaje: c.mensaje, archivos: { cdrXml: c.cdrXml } })
  } catch (e) {
    // Una configuración mala (certificado vencido, credenciales, ambiente de pruebas) o un error inesperado NO es un rechazo de SUNAT: se reintenta y, si no se arregla, queda AGOTADA.
    return reintentar(recortarError(e))
  }
}

type Cierre = { estado: 'ACEPTADA' | 'RECHAZADA'; codigo: string | null; mensaje: string | null; archivos?: { xmlFirmado?: string; cdrXml?: string } }

/** SUNAT dio una respuesta DEFINITIVA: se cierra la solicitud y, si fue aceptada, el comprobante pasa a ANULADO (todo en una transacción, con sus archivos). */
async function resolver(
  db: TenantPrismaClient, fila: BajaReclamada, mio: Record<string, unknown>, taxDocumentId: string, ahora: Date, c: Cierre,
): Promise<ResultadoFila> {
  const ok = await db.$transaction(async (tx) => {
    const x = tx as unknown as TenantPrismaClient
    const v = await x.taxVoid.updateMany({
      where: mio,
      data: { status: c.estado, responseCode: c.codigo, responseMessage: c.mensaje, resolvedAt: ahora, lockedUntil: null, lockedBy: null, lastError: null },
    })
    if (v.count !== 1) return false
    await guardarArchivosBaja(x, fila.tenantId, fila.id, c.archivos)
    if (c.estado === 'ACEPTADA') {
      const razon = await x.taxVoid.findFirstOrThrow({ where: { id: fila.id }, select: { reason: true, identifier: true } })
      await x.taxDocument.updateMany({
        where: { id: taxDocumentId, status: { in: ['ACEPTADO', 'OBSERVADO'] } },
        data: { status: 'ANULADO', voidedAt: ahora, voidReason: razon.reason, statusMessage: `Dado de baja ante SUNAT (${razon.identifier})` },
      })
    }
    const detalle = { codigo: c.codigo, mensaje: c.mensaje }
    if (c.estado === 'ACEPTADA') {
      await x.auditLog.create({ data: { tenantId: fila.tenantId, action: 'baja.aceptada', entityType: 'TaxDocument', entityId: taxDocumentId, after: detalle } })
    } else {
      await x.auditLog.create({ data: { tenantId: fila.tenantId, action: 'baja.rechazada', entityType: 'TaxDocument', entityId: taxDocumentId, after: detalle } })
    }
    return true
  })
  return ok ? 'completado' : 'perdido'
}

/** Se cierra la solicitud SIN llamar a SUNAT (el plazo venció, o el comprobante ya no es dado de baja): RECHAZADA con el motivo, el comprobante intacto. */
async function cerrarSinSunat(
  db: TenantPrismaClient, fila: BajaReclamada, mio: Record<string, unknown>, motivo: string, ahora: Date, taxDocumentId?: string,
): Promise<ResultadoFila> {
  return resolver(db, fila, mio, taxDocumentId ?? fila.taxDocumentId, ahora, { estado: 'RECHAZADA', codigo: null, mensaje: motivo })
}
