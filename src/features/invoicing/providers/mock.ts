import { createHash } from 'node:crypto'
import type {
  ComprobanteFiscal, CredencialesProveedor, Descarga, EstadoComprobante,
  FormatoDescarga, ProveedorFacturacion, ResultadoBaja, ResultadoEmision,
} from './types'
import { ErrorConfiguracionProveedor } from './errores'

/**
 * Proveedor simulado.
 *
 * ─── PARA QUÉ SIRVE DE VERDAD ────────────────────────────────────────────
 *
 * No es un placeholder que devuelve `ok: true`. Reproduce los
 * comportamientos del mundo real que el código que lo consume TIENE que
 * manejar, porque son los que hacen fallar una integración de verdad:
 *
 *   · Rechazo de fondo, NO reintentable (RUC inválido, correlativo duplicado).
 *   · Fallo transitorio, SÍ reintentable (503 del proveedor).
 *   · Respuesta ASÍNCRONA: devuelve ticket y el CDR llega después.
 *   · Idempotencia: reemitir (serie, correlativo) devuelve lo mismo.
 *
 * Con un mock que siempre acepta, el día del proveedor real se descubre que
 * nadie escribió el camino del rechazo. Con este, ese camino está probado
 * antes de firmar contrato.
 *
 * El comportamiento se dirige con el campo `usuario` de las credenciales,
 * para que una prueba pueda pedir el escenario que quiere sin tocar el mock.
 */

/** Escenarios que se piden por el campo `usuario`. */
const ESCENARIOS = {
  'mock:acepta': 'Acepta al instante.',
  'mock:rechaza': 'Rechazo de fondo, no reintentable.',
  'mock:transitorio': 'Fallo transitorio, reintentable.',
  'mock:asincrono': 'Devuelve ticket; el CDR llega después.',
} as const

export type EscenarioMock = keyof typeof ESCENARIOS

/** Memoria del proceso: sirve para la idempotencia y para el flujo asíncrono. */
const emitidos = new Map<string, ResultadoEmision>()
const tickets = new Map<string, { clave: string; consultas: number }>()

const clave = (c: { serie: string; correlativo: number }) => `${c.serie}-${c.correlativo}`

function hashDe(comprobante: ComprobanteFiscal): string {
  return createHash('sha256')
    .update(
      [
        comprobante.emisor.ruc,
        comprobante.tipoComprobante,
        comprobante.serie,
        comprobante.correlativo,
        comprobante.totalIgv.toFixed(2),
        comprobante.total.toFixed(2),
        comprobante.fechaEmision,
      ].join('|'),
    )
    .digest('base64')
}

export const proveedorMock: ProveedorFacturacion = {
  nombre: 'mock',

  async emitir(comprobante, credenciales): Promise<ResultadoEmision> {
    const k = clave(comprobante)

    /*
     * IDEMPOTENCIA. Un reintento tras un timeout de red debe devolver el
     * mismo comprobante, no emitir un segundo con el mismo correlativo. Es el
     * fallo más caro de una integración de facturación: produce duplicados
     * ante SUNAT que solo se arreglan con nota de crédito.
     */
    const yaEmitido = emitidos.get(k)
    if (yaEmitido) return yaEmitido

    const escenario = credenciales.usuario as EscenarioMock

    if (escenario === 'mock:transitorio') {
      // No se guarda: el reintento debe poder tener éxito.
      return {
        estado: 'PENDIENTE',
        idExterno: null,
        ticket: null,
        codigoRespuesta: null,
        mensaje: 'El servicio del proveedor no responde (503). Reintentar.',
        hashXml: null,
        reintentable: true,
      }
    }

    if (escenario === 'mock:rechaza') {
      const r: ResultadoEmision = {
        estado: 'RECHAZADO',
        idExterno: `mock-${k}`,
        ticket: null,
        codigoRespuesta: '2017',
        mensaje:
          'El RUC del emisor no está autorizado a emitir este tipo de comprobante. ' +
          'Reintentar no lo arregla: hay que corregir los datos.',
        hashXml: null,
        reintentable: false,
      }
      emitidos.set(k, r)
      return r
    }

    if (escenario === 'mock:asincrono') {
      const ticket = `TKT-${Date.now()}-${k}`
      tickets.set(ticket, { clave: k, consultas: 0 })
      const r: ResultadoEmision = {
        estado: 'ENVIADO',
        idExterno: `mock-${k}`,
        ticket,
        codigoRespuesta: null,
        mensaje: 'Recibido. El CDR llegará en unos minutos.',
        hashXml: hashDe(comprobante),
        reintentable: false,
      }
      emitidos.set(k, r)
      return r
    }

    const r: ResultadoEmision = {
      estado: 'ACEPTADO',
      idExterno: `mock-${k}`,
      ticket: null,
      codigoRespuesta: '0',
      mensaje: 'Aceptado por SUNAT (simulado).',
      hashXml: hashDe(comprobante),
      reintentable: false,
    }
    emitidos.set(k, r)
    return r
  },

  async consultarEstado(referencia): Promise<EstadoComprobante> {
    if (referencia.ticket) {
      const t = tickets.get(referencia.ticket)
      if (!t) {
        return {
          estado: 'ENVIADO',
          codigoRespuesta: null,
          mensaje: 'Ticket desconocido.',
          aceptadoEn: null,
        }
      }
      t.consultas += 1
      /*
       * Dos consultas antes de resolver: así la prueba ejerce el camino de
       * "todavía no hay respuesta", que es donde un bucle de sondeo mal
       * escrito se cuelga o da el comprobante por perdido.
       */
      if (t.consultas < 2) {
        return {
          estado: 'ENVIADO',
          codigoRespuesta: null,
          mensaje: 'En proceso.',
          aceptadoEn: null,
        }
      }
      return {
        estado: 'ACEPTADO',
        codigoRespuesta: '0',
        mensaje: 'Aceptado por SUNAT (simulado).',
        aceptadoEn: new Date().toISOString(),
      }
    }

    const r = emitidos.get(clave(referencia))
    if (!r) {
      return {
        estado: 'PENDIENTE',
        codigoRespuesta: null,
        mensaje: 'El proveedor no conoce este comprobante.',
        aceptadoEn: null,
      }
    }
    return {
      estado: r.estado,
      codigoRespuesta: r.codigoRespuesta,
      mensaje: r.mensaje,
      aceptadoEn: r.estado === 'ACEPTADO' ? new Date().toISOString() : null,
    }
  },

  async comunicarBaja(): Promise<never> {
    throw new ErrorConfiguracionProveedor('El proveedor simulado no comunica bajas: las cuentas de demostración no dan de baja ante SUNAT.')
  },

  async consultarBaja(): Promise<never> {
    throw new ErrorConfiguracionProveedor('El proveedor simulado no comunica bajas.')
  },

  async anular(referencia, motivo): Promise<ResultadoBaja> {
    const r = emitidos.get(clave(referencia))
    if (!r) {
      return { ticket: null, estado: 'PENDIENTE', mensaje: 'Comprobante desconocido.' }
    }
    if (r.estado !== 'ACEPTADO') {
      return {
        ticket: null,
        estado: r.estado,
        mensaje: 'Solo se anula un comprobante ACEPTADO.',
      }
    }
    return {
      ticket: `BAJA-${Date.now()}`,
      estado: 'ANULADO',
      mensaje: `Baja aceptada (simulada). Motivo: ${motivo}`,
    }
  },

  async descargar(referencia, formato: FormatoDescarga): Promise<Descarga> {
    const k = clave(referencia)
    const tipos: Record<FormatoDescarga, string> = {
      XML: 'application/xml',
      CDR: 'application/zip',
      PDF: 'application/pdf',
    }
    return {
      formato,
      contenidoBase64: Buffer.from(`<!-- ${formato} simulado de ${k} -->`).toString('base64'),
      nombreArchivo: `${k}.${formato.toLowerCase()}`,
      tipoMime: tipos[formato],
    }
  },

  async verificarCredenciales(credenciales: CredencialesProveedor) {
    if (!credenciales.usuario || !credenciales.clave) {
      return { ok: false, mensaje: 'Faltan usuario o clave del proveedor.' }
    }
    if (credenciales.usuario === 'mock:credencial-mala') {
      return { ok: false, mensaje: 'Credenciales rechazadas por el proveedor.' }
    }
    return {
      ok: true,
      mensaje: `Credenciales válidas (simulado). Escenario: ${
        ESCENARIOS[credenciales.usuario as EscenarioMock] ?? 'acepta por defecto'
      }`,
      certificadoVenceEn: new Date(Date.now() + 365 * 86_400_000).toISOString(),
    }
  },
}

/** Limpia la memoria del mock. Solo para las pruebas. */
export function reiniciarMock(): void {
  emitidos.clear()
  tickets.clear()
}
