/**
 * Qué significa cada `AuditLog.action` para una persona. Puro: sin base ni React.
 *
 * Regla: una acción que no está aquí NUNCA se esconde. Se muestra con su código tal cual y en «Otros», para que un evento nuevo sin
 * etiqueta siga siendo visible (`tests/auditoria-catalogo.ts` falla si alguien añade una acción en el código y olvida etiquetarla).
 */
export const CATEGORIAS = [
  'Ventas y caja', 'Crédito y cobranza', 'Clientes', 'Compras y proveedores', 'Inventario', 'Comprobantes y guías',
  'Equipo y seguridad', 'Sucursales', 'Reportes', 'Soporte', 'Cuenta y plan', 'Otros',
] as const
export type Categoria = (typeof CATEGORIAS)[number]

const V: Categoria = 'Ventas y caja', CR: Categoria = 'Crédito y cobranza', CL: Categoria = 'Clientes', CP: Categoria = 'Compras y proveedores'
const IN: Categoria = 'Inventario', CO: Categoria = 'Comprobantes y guías', EQ: Categoria = 'Equipo y seguridad', SU: Categoria = 'Sucursales'
const SO: Categoria = 'Soporte', CU: Categoria = 'Cuenta y plan'

export const ACCIONES: Readonly<Record<string, { categoria: Categoria; etiqueta: string }>> = {
  'sale.below_stock': { categoria: V, etiqueta: 'Venta con stock insuficiente' },
  'sale.discount': { categoria: V, etiqueta: 'Descuento aplicado' },
  'cash.open': { categoria: V, etiqueta: 'Caja abierta' },
  'venta.anulada': { categoria: V, etiqueta: 'Venta anulada' },
  'venta.devuelta': { categoria: V, etiqueta: 'Venta devuelta' },
  'venta.devuelta_parcial': { categoria: V, etiqueta: 'Devolución parcial de una venta' },
  'caja.obligatoria': { categoria: V, etiqueta: 'Cambió la obligación de abrir caja' },
  'pedido.cancelar': { categoria: V, etiqueta: 'Pedido cancelado' },
  'pedido.soltar': { categoria: V, etiqueta: 'Pedido liberado' },
  'descuento.tope': { categoria: V, etiqueta: 'Cambió el tope de descuento' },
  'credito.abono': { categoria: CR, etiqueta: 'Abono de un cliente' },
  'credito.abono_anulado': { categoria: CR, etiqueta: 'Abono anulado' },
  'credito.configurado': { categoria: CR, etiqueta: 'Línea de crédito configurada' },
  'credito.cuenta_anulada': { categoria: CR, etiqueta: 'Deuda dada de baja' },
  'credito.cuenta_reducida': { categoria: CR, etiqueta: 'Deuda reducida por una devolución' },
  'credito.otorgado': { categoria: CR, etiqueta: 'Venta al crédito otorgada' },
  'credito.revision_descartada': { categoria: CR, etiqueta: 'Revisión de crédito descartada' },
  'credito.revision_marcada': { categoria: CR, etiqueta: 'Crédito marcado para revisión' },
  'cliente.creado': { categoria: CL, etiqueta: 'Cliente creado' },
  'cliente.editado': { categoria: CL, etiqueta: 'Cliente editado' },
  'cliente.baja': { categoria: CL, etiqueta: 'Cliente dado de baja' },
  'cliente.reactivado': { categoria: CL, etiqueta: 'Cliente reactivado' },
  'compra.creada': { categoria: CP, etiqueta: 'Compra registrada' },
  'compra.editada': { categoria: CP, etiqueta: 'Compra editada' },
  'compra.recibida': { categoria: CP, etiqueta: 'Compra recibida' },
  'compra.anulada': { categoria: CP, etiqueta: 'Compra anulada' },
  'compra.documento': { categoria: CP, etiqueta: 'Documento de una compra completado' },
  'proveedor.creado': { categoria: CP, etiqueta: 'Proveedor creado' },
  'proveedor.editado': { categoria: CP, etiqueta: 'Proveedor editado' },
  'proveedor.baja': { categoria: CP, etiqueta: 'Proveedor dado de baja' },
  'proveedor.reactivado': { categoria: CP, etiqueta: 'Proveedor reactivado' },
  'proveedor.pago': { categoria: CP, etiqueta: 'Pago a proveedor' },
  'proveedor.pago_anulado': { categoria: CP, etiqueta: 'Pago a proveedor anulado' },
  'stock.adjust': { categoria: IN, etiqueta: 'Stock ajustado' },
  'stock.completar_costo': { categoria: IN, etiqueta: 'Costo pendiente completado' },
  'merma.solicitar': { categoria: IN, etiqueta: 'Merma solicitada' },
  'product.create.express': { categoria: IN, etiqueta: 'Producto creado desde el mostrador' },
  'presentacion.crear': { categoria: IN, etiqueta: 'Presentación creada' },
  'presentacion.desactivar': { categoria: IN, etiqueta: 'Presentación desactivada' },
  'catalog.import': { categoria: IN, etiqueta: 'Catálogo importado' },
  'comprobante.enviar': { categoria: CO, etiqueta: 'Comprobante enviado a SUNAT' },
  'comprobante.respuesta': { categoria: CO, etiqueta: 'Respuesta de SUNAT recibida' },
  'taxdocument.issue': { categoria: CO, etiqueta: 'Comprobante emitido' },
  'taxdocument.nota_credito': { categoria: CO, etiqueta: 'Nota de crédito emitida' },
  'taxdocument.status.manual': { categoria: CO, etiqueta: 'Estado de un comprobante cambiado a mano' },
  'guia.emitir': { categoria: CO, etiqueta: 'Guía de remisión emitida' },
  'guia.anular': { categoria: CO, etiqueta: 'Guía de remisión anulada' },
  'cola.agotado': { categoria: CO, etiqueta: 'Envío fiscal agotó sus reintentos' },
  'cola.reintento_manual': { categoria: CO, etiqueta: 'Reintento manual de un envío fiscal' },
  'counter.startNumber': { categoria: CO, etiqueta: 'Numeración inicial de una serie fijada' },
  'pse.configurar': { categoria: CO, etiqueta: 'Proveedor de facturación configurado' },
  'pse.quitar': { categoria: CO, etiqueta: 'Proveedor de facturación quitado' },
  'tenant.facturacion_real.umbrales': { categoria: CO, etiqueta: 'Umbrales de facturación real cambiados' },
  'usuario.aceptar_invitacion': { categoria: EQ, etiqueta: 'Invitación aceptada' },
  'mfa.restablecer': { categoria: EQ, etiqueta: 'Segundo factor restablecido' },
  'pin.salir': { categoria: EQ, etiqueta: 'Salida de un operador con PIN' },
  'sesion.cerrar_todas': { categoria: EQ, etiqueta: 'Sesiones cerradas en todos los dispositivos' },
  'branch.create': { categoria: SU, etiqueta: 'Sucursal creada' },
  'branch.update': { categoria: SU, etiqueta: 'Sucursal editada' },
  'branch.delete': { categoria: SU, etiqueta: 'Sucursal eliminada' },
  'branch.assign': { categoria: SU, etiqueta: 'Usuario asignado a una sucursal' },
  'reporte.exportado': { categoria: 'Reportes', etiqueta: 'Reporte descargado' },
  'impersonation.start': { categoria: SO, etiqueta: 'Soporte entró a tu cuenta' },
  'impersonation.end': { categoria: SO, etiqueta: 'Soporte salió de tu cuenta' },
  'tenant.suspend': { categoria: CU, etiqueta: 'Cuenta suspendida' },
  'tenant.reactivate': { categoria: CU, etiqueta: 'Cuenta reactivada' },
  'tenant.trial.extend': { categoria: CU, etiqueta: 'Prueba extendida' },
  'tenant.plan.change': { categoria: CU, etiqueta: 'Plan cambiado' },
  'tenant.profile.update': { categoria: CU, etiqueta: 'Datos del negocio actualizados' },
  'tenant.password.reset': { categoria: CU, etiqueta: 'Contraseña restablecida por soporte' },
  'trial.expired': { categoria: CU, etiqueta: 'Prueba vencida' },
  'superadmin.password.change': { categoria: CU, etiqueta: 'Contraseña de soporte cambiada' },
}

/** Cadenas `action: '…'` del código que NO son registros de auditoría (estados de suscripción, parámetros…): el test de completitud las ignora. */
export const ACCIONES_QUE_NO_SON_AUDITORIA: readonly string[] = ['ACTIVATE', 'CANCEL', 'MARK_PAST_DUE', 'NOOP', 'SYNC', 'action']

export function describirAccion(codigo: string): { categoria: Categoria; etiqueta: string } {
  return ACCIONES[codigo] ?? { categoria: 'Otros', etiqueta: codigo }
}

/** Los códigos de una categoría. `Otros` se filtra por exclusión (todo lo que no esté en el catálogo), así que aquí devuelve []. */
export function accionesDe(categoria: Categoria): string[] {
  return Object.entries(ACCIONES).filter(([, v]) => v.categoria === categoria).map(([k]) => k)
}
export const CODIGOS_CONOCIDOS: readonly string[] = Object.keys(ACCIONES)
