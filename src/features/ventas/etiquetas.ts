/** Rótulos en español de los medios de pago y de lo que se ve en el historial de ventas. Puro. */
export const ETIQUETA_MEDIO: Record<string, string> = {
  EFECTIVO: 'Efectivo', YAPE: 'Yape', PLIN: 'Plin', TARJETA_DEBITO: 'Tarjeta de débito', TARJETA_CREDITO: 'Tarjeta de crédito',
  TRANSFERENCIA: 'Transferencia', CREDITO: 'Fiado (a crédito)', OTRO: 'Otro medio',
}
export const medio = (m: string) => ETIQUETA_MEDIO[m] ?? m.replace(/_/g, ' ').toLowerCase()

/** Medios por los que se puede devolver dinero SIN tocar el cajón (ni efectivo ni crédito). */
export const MEDIOS_EXTERNOS = ['YAPE', 'PLIN', 'TRANSFERENCIA', 'TARJETA_DEBITO', 'TARJETA_CREDITO', 'OTRO'] as const

export const ETIQUETA_ESTADO_COMPROBANTE: Record<string, string> = {
  PENDIENTE: 'Pendiente de envío', ENVIADO: 'Enviado, esperando respuesta', ACEPTADO: 'Aceptado', OBSERVADO: 'Aceptado con observaciones', RECHAZADO: 'Rechazado', ANULADO: 'Anulado',
}
export const ETIQUETA_TIPO_COMPROBANTE: Record<string, string> = { BOLETA: 'Boleta', FACTURA: 'Factura', NOTA_CREDITO: 'Nota de crédito', NOTA_DEBITO: 'Nota de débito' }
export const ETIQUETA_MODO_REEMBOLSO = { CAJA: 'Sale de la caja (efectivo)', EXTERNO: 'Por otro medio, sin tocar el cajón', SIN_SALIDA: 'No se devolvió dinero' } as const
