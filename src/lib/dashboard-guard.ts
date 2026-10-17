import { redirect } from 'next/navigation'
import { requireTenantContext } from './session'
import { ROUTES, resolveAccountGate, type AccountNotice } from './route-access'
import { isBusinessError, TenantIsolationError } from './errors'
import type { TenantContext } from './tenant-context'

/**
 * Guarda del panel de cliente, CONTRA LA BASE DE DATOS.
 *
 * ─── POR QUÉ EXISTE ──────────────────────────────────────────────────────
 *
 * El proxy dejó de consultar la base (ver la cabecera de src/proxy.ts: su
 * consulta costaba 120-140 ms por navegación porque corre lejos de la base).
 * Con eso dejó de poder redirigir por motivos que solo la base conoce:
 *
 *   · usuario desactivado o borrado
 *   · sesión revocada por un cambio de contraseña
 *   · tenant suspendido por el Super Admin
 *   · suscripción vencida o en mora
 *
 * Esas comprobaciones NO desaparecieron: se hacen aquí, en el layout del
 * panel, que corre pegado a la base y resuelve la sesión UNA vez (memoizada,
 * compartida con todas las páginas del render).
 *
 * El cambio es DÓNDE se bloquea, no SI se bloquea.
 *
 * ─── POR QUÉ UN REDIRECT Y NO DEJAR QUE LANCE ────────────────────────────
 *
 * `requireTenantContext()` lanza, y eso es correcto para una Server Action:
 * el cliente recibe un error tipado. Pero en una navegación produciría la
 * página de error de Next, que al usuario no le dice nada útil. Aquí se
 * traduce a la redirección que corresponda.
 */
export interface GuardResultado {
  ctx: TenantContext
  /** Aviso de cuenta para el banner, si procede. */
  notice: AccountNotice | null
}

export async function guardDashboard(): Promise<GuardResultado> {
  let ctx: TenantContext
  try {
    ctx = await requireTenantContext()
  } catch (e) {
    /*
     * Cualquier fallo de identidad acaba en el login con el motivo. Se
     * distinguen los casos para el log, no para el usuario: decirle «tu
     * usuario está desactivado» frente a «tu sesión expiró» le da
     * información sobre cuentas ajenas a quien esté probando correos.
     */
    if (isBusinessError(e) && e.code === 'UNAUTHENTICATED') {
      redirect(`${ROUTES.login}?motivo=sesion`)
    }
    if (e instanceof TenantIsolationError) {
      redirect(`${ROUTES.login}?motivo=sesion`)
    }
    throw e
  }

  /*
   * La decisión se delega en `resolveAccountGate`, la MISMA función pura que
   * usa la política completa. Reimplementarla aquí daría dos sitios con las
   * reglas de suspensión y mora, y el día que divergieran nadie sabría cuál
   * manda.
   */
  const gate = resolveAccountGate({
    role: ctx.role,
    tenantId: ctx.tenantId,
    access: ctx.access,
    impersonatorId: ctx.impersonationId,
  })

  if (gate?.kind === 'suspended') {
    redirect(ROUTES.suspended)
  }

  /*
   * Un SUPERADMIN sin modo soporte no debería llegar aquí —el proxy ya lo
   * desvía con el rol del token— pero si su token está obsoleto, sí llega.
   */
  if (gate?.kind === 'superadmin-sin-soporte') {
    redirect(ROUTES.superadmin)
  }

  return { ctx, notice: gate?.kind === 'notice' ? gate.notice : null }
}

/*
 * NO hay `guardSuperadmin` aquí a propósito.
 *
 * `(superadmin)/layout.tsx` ya lee el rol REAL de la base y responde
 * notFound(). Añadir una segunda guarda equivalente en otro archivo daría
 * dos sitios que mantener sincronizados, y el día que divergieran nadie
 * sabría cuál manda.
 */
