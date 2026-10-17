/**
 * Validación del código de establecimiento anexo ante SUNAT.
 *
 * ─── POR QUÉ HOY SOLO SE VALIDA EL FORMATO ───────────────────────────────
 *
 * El código de un anexo se consulta y se da de alta en SUNAT Virtual, DETRÁS
 * de la Clave SOL del contribuyente. No existe un endpoint público que, dado
 * un RUC, devuelva sus establecimientos: la ficha RUC pública no los trae.
 *
 * Las únicas vías para comprobarlo de verdad son:
 *
 *   1. La Clave SOL del propio negocio (credencial sensible: habría que
 *      pedirla, guardarla cifrada y mantenerla; es la llave de su buzón
 *      tributario, no un dato de configuración).
 *   2. Un servicio de terceros que haga scraping del portal. De pago,
 *      no oficial, y se rompe cuando SUNAT cambia el HTML.
 *
 * Mientras no haya una de las dos, el código se TECLEA. Y como un código
 * equivocado sale impreso en los comprobantes atribuyéndolos a un
 * establecimiento ajeno, la UI tiene que decirlo con claridad en lugar de
 * aceptarlo en silencio. Eso es lo que hace `avisoEstablecimiento`.
 *
 * `verificarEstablecimiento` queda como punto de enganche: el día que haya
 * credenciales o proveedor, se implementa ahí y la UI pasa de "sin verificar"
 * a "verificado" sin tocar nada más.
 */

export type EstadoVerificacion = 'SIN_VERIFICAR' | 'VERIFICADO' | 'NO_COINCIDE'

export interface ResultadoVerificacion {
  estado: EstadoVerificacion
  /** Texto para la UI. Siempre presente, también cuando no se pudo verificar. */
  mensaje: string
}

/** "0000" es la casa matriz; cualquier otro valor es un anexo declarado. */
export function esCasaMatriz(establishmentCode: string): boolean {
  return establishmentCode === '0000'
}

/**
 * Aviso que debe mostrar la UI junto al campo.
 *
 * Se distingue la casa matriz del anexo a propósito: "0000" es siempre
 * correcto por definición y no merece una advertencia que el usuario
 * aprendería a ignorar. El aviso se reserva para el caso en que importa.
 */
export function avisoEstablecimiento(establishmentCode: string): string | null {
  if (esCasaMatriz(establishmentCode)) return null
  return (
    'No podemos comprobar este código contra tu RUC: SUNAT solo expone los ' +
    'establecimientos anexos detrás de tu Clave SOL. Verifícalo en SUNAT ' +
    'Virtual antes de emitir, porque va impreso en cada comprobante de esta ' +
    'sucursal y no se puede cambiar después.'
  )
}

/**
 * Punto de enganche para la verificación real. Hoy siempre SIN_VERIFICAR.
 *
 * Devuelve un resultado en lugar de lanzar: no poder verificar NO es un
 * error del usuario y no debe impedirle abrir su sucursal.
 */
export async function verificarEstablecimiento(
  ruc: string | null,
  establishmentCode: string,
): Promise<ResultadoVerificacion> {
  if (esCasaMatriz(establishmentCode)) {
    return {
      estado: 'VERIFICADO',
      mensaje: 'Casa matriz: el código 0000 no necesita verificación.',
    }
  }
  if (!ruc) {
    return {
      estado: 'SIN_VERIFICAR',
      mensaje: 'Declara el RUC del negocio para poder verificar sus establecimientos.',
    }
  }
  return {
    estado: 'SIN_VERIFICAR',
    mensaje: avisoEstablecimiento(establishmentCode)!,
  }
}
