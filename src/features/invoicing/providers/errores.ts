/**
 * Un problema de CONFIGURACIÓN del proveedor (faltan credenciales, certificado vencido o ajeno, SUNAT rechazó el acceso): NO es un rechazo del comprobante, así que no
 * cambia su estado. Quien envía lo convierte en un error de negocio y el comprobante sigue PENDIENTE hasta que se arregle la configuración.
 */
export class ErrorConfiguracionProveedor extends Error {
  constructor(mensaje: string) { super(mensaje); this.name = 'ErrorConfiguracionProveedor' }
}
