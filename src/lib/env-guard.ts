/**
 * Blindaje de los scripts que escriben en la base.
 *
 * ─── EL INCIDENTE QUE LO MOTIVA ──────────────────────────────────────────
 *
 * `prisma db seed` se ejecutó contra producción por accidente: el CLI cargaba
 * solo `.env` y `.env` apunta a Neon. El seed hace `upsert` del SUPERADMIN
 * con `passwordHash` en la rama `update`, así que SOBREESCRIBIÓ la contraseña
 * que el dueño había cambiado una hora antes y lo dejó fuera de su propio
 * sistema.
 *
 * La guardia de los tests no cubría esto: solo vivía en `tests/`. Faltaba en
 * los scripts, que son precisamente los que escriben usuarios.
 *
 * ─── LA REGLA: DENEGAR POR DEFECTO ───────────────────────────────────────
 *
 * Un script destructivo no se ejecuta salvo que el entorno se declare
 * desechable (`ALLOW_DESTRUCTIVE_TESTS=true`, que vive en el `.env.local` de
 * staging y NUNCA en producción).
 *
 * Para los casos en que de verdad hay que actuar sobre producción —restaurar
 * el acceso del dueño, por ejemplo— existe un permiso explícito y de un solo
 * uso: `I_UNDERSTAND_THIS_IS_PRODUCTION=true`. Hay que escribirlo en la
 * propia línea de comandos, no puede quedarse olvidado en un fichero, y el
 * script avisa a gritos de lo que va a hacer.
 *
 * El orden importa: primero se niega, luego se pregunta. Al revés —detectar
 * si "parece" producción— falla en cuanto cambia el host, y el modo de fallo
 * es destruir datos.
 */

export interface GuardOptions {
  /** Nombre del script, para los mensajes. */
  script: string
  /** Qué va a escribir, en una línea. Se le muestra al operador. */
  efecto: string
}

function host(url: string | undefined): string {
  if (!url) return '(sin DATABASE_URL)'
  try {
    const u = new URL(url)
    return `${u.hostname}${u.pathname}`
  } catch {
    return '(URL ilegible)'
  }
}

/**
 * Aborta si el entorno no está autorizado para escrituras destructivas.
 * Lanza en lugar de devolver un booleano: así es imposible ignorar el
 * resultado por descuido.
 */
export function assertWritableEnvironment(opts: GuardOptions): void {
  const desechable = process.env.ALLOW_DESTRUCTIVE_TESTS === 'true'
  const produccionExplicita = process.env.I_UNDERSTAND_THIS_IS_PRODUCTION === 'true'
  const destino = host(process.env.DATABASE_URL)

  if (desechable && produccionExplicita) {
    throw new Error(
      `[${opts.script}] ALLOW_DESTRUCTIVE_TESTS y ` +
        'I_UNDERSTAND_THIS_IS_PRODUCTION están ambas activas. Son ' +
        'incompatibles: un entorno es desechable o es producción, no los dos. ' +
        'Revisa qué fichero de entorno se está cargando.',
    )
  }

  if (desechable) return

  if (produccionExplicita) {
    console.warn(`
╔════════════════════════════════════════════════════════════════════════╗
║  ESCRIBIENDO EN PRODUCCIÓN — permiso explícito concedido               ║
╚════════════════════════════════════════════════════════════════════════╝
  script:  ${opts.script}
  efecto:  ${opts.efecto}
  destino: ${destino}
`)
    return
  }

  throw new Error(`
╔════════════════════════════════════════════════════════════════════════╗
║  ABORTADO — entorno no autorizado para escrituras                      ║
╚════════════════════════════════════════════════════════════════════════╝

  script:  ${opts.script}
  efecto:  ${opts.efecto}
  destino: ${destino}

  Este script escribe en la base y el entorno no se ha declarado
  desechable. Se aborta ANTES de tocar nada.

  Para STAGING, en su .env.local:
      ALLOW_DESTRUCTIVE_TESTS=true

  Para PRODUCCIÓN, solo si de verdad hace falta, en la propia línea:
      I_UNDERSTAND_THIS_IS_PRODUCTION=true npx tsx ${opts.script}

  Ese permiso NO debe guardarse en ningún fichero de entorno: se escribe
  a mano, una vez, y desaparece al terminar el comando.
`)
}
