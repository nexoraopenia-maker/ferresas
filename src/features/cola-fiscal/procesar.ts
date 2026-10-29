import { getTenantPrisma } from '@/lib/tenant-prisma'
import type { TenantContext } from '@/lib/tenant-context'
import {
  consultarInterno, enviarInterno, NotaEsperaOriginal, type ActorEnvio, type DependenciasEnvio,
} from '@/features/invoicing/envio'
import { modoFiscal } from '@/features/invoicing/modo-fiscal'
import { agotar, completar, liberar, pasarAConsulta, reprogramar, type FilaReclamada } from './repositorio'
import { proximoIntento, recortarError } from './reglas'

/**
 * Procesa UNA fila ya reclamada: la envía (o consulta su estado) con el cliente acotado a SU negocio
 * y deja la fila en el estado que toque.
 *
 * NUNCA marca «aceptado» por su cuenta: el estado del comprobante lo fija solo la respuesta del
 * proveedor, dentro de `enviarInterno`/`consultarInterno`. Aquí, ante una excepción o una respuesta
 * transitoria, solo se reprograma o se agota la FILA; el comprobante sigue PENDIENTE.
 */

export type ResultadoFila = 'completado' | 'reintento' | 'agotado' | 'liberado' | 'consulta' | 'perdido'

/** Contexto del sistema: solo sirve para acotar el cliente al negocio; el envío interno no mira permisos. */
export const contextoDeSistema = (tenantId: string): TenantContext => ({ tenantId, userId: 'sistema', role: 'SUPERADMIN', access: 'FULL' })

const actorCola = (tenantId: string): ActorEnvio => ({ tenantId, id: null, role: null, origen: 'cola' })

const ESPERA_CONSULTA_S = 60
const ESPERA_LIBERACION_S = 60
/** Una nota espera a que su comprobante original esté aceptado: se vuelve a mirar en 5 min, sin gastar el intento. */
const ESPERA_NOTA_S = 300

export async function procesarFila(
  fila: FilaReclamada, deps: DependenciasEnvio = {}, ahora: Date = new Date(),
): Promise<ResultadoFila> {
  const db = getTenantPrisma(contextoDeSistema(fila.tenantId))
  const en = (s: number) => new Date(ahora.getTime() + s * 1000)

  // El negocio pudo cambiar de modo entre el reclamo y ahora (p. ej. se pausó): se relee.
  const t = await db.tenant.findFirst({ select: { isDemo: true, realBillingEnabledAt: true, realBillingPausedAt: true } })
  if (!t || modoFiscal(t) !== 'REAL') {
    return (await liberar(fila, en(ESPERA_LIBERACION_S))) ? 'liberado' : 'perdido'
  }

  const doc = await db.taxDocument.findFirst({ where: { id: fila.taxDocumentId }, select: { status: true, isTrial: true } })
  if (!doc) return (await completar(fila, ahora, 'El comprobante ya no existe.')) ? 'completado' : 'perdido'
  // Defensa en profundidad: el reclamo ya los excluye, pero un documento de prueba JAMÁS llega al proveedor.
  if (doc.isTrial) return (await completar(fila, ahora, 'Documento de prueba: no se envía.')) ? 'completado' : 'perdido'

  if (fila.op === 'ENVIAR' && doc.status !== 'PENDIENTE') {
    // Ya lo resolvió otro camino (p. ej. un envío manual): si quedó a la espera, se consulta; si no, está hecho.
    if (doc.status === 'ENVIADO') return (await pasarAConsulta(fila, en(ESPERA_CONSULTA_S))) ? 'consulta' : 'perdido'
    return (await completar(fila, ahora, `Ya estaba ${doc.status.toLowerCase()}.`)) ? 'completado' : 'perdido'
  }

  const fallo = async (motivo: string): Promise<ResultadoFila> => {
    const s = proximoIntento(fila.attempts, ahora)
    if (s.agotado) return (await agotar(fila, ahora, motivo)) ? 'agotado' : 'perdido'
    return (await reprogramar(fila, s.en, motivo)) ? 'reintento' : 'perdido'
  }

  try {
    const actor = actorCola(fila.tenantId)
    const r = fila.op === 'ENVIAR'
      ? await enviarInterno(db, actor, fila.taxDocumentId, { ...deps, ahora })
      : await consultarInterno(db, actor, fila.taxDocumentId, { ...deps, ahora })

    // Una respuesta transitoria del proveedor NO es una respuesta: el comprobante sigue PENDIENTE.
    if (r.reintentable) return fallo(r.mensaje ?? 'El proveedor no respondió.')

    if (r.estado === 'ACEPTADO' || r.estado === 'OBSERVADO') return (await completar(fila, ahora, null)) ? 'completado' : 'perdido'
    // Un rechazo es una respuesta DEFINITIVA: reintentar el mismo XML daría el mismo rechazo. Se guarda el motivo.
    if (r.estado === 'RECHAZADO') return (await completar(fila, ahora, r.mensaje ?? 'Rechazado por el proveedor.')) ? 'completado' : 'perdido'
    if (r.estado === 'ENVIADO') return (await pasarAConsulta(fila, en(ESPERA_CONSULTA_S))) ? 'consulta' : 'perdido'
    return fallo(`Respuesta sin estado definitivo (${r.estado}).`)
  } catch (e) {
    // La nota depende de su original: no es un fallo suyo. Se libera SIN gastar el intento (como un negocio pausado).
    if (e instanceof NotaEsperaOriginal) return (await liberar(fila, en(ESPERA_NOTA_S), e.message)) ? 'liberado' : 'perdido'
    return fallo(recortarError(e))
  }
}
