import { NextResponse, type NextRequest } from 'next/server'
import { auth } from '@/auth'
import {
  requiresSessionLookup,
  resolveRouteAccessFromToken,
  type TokenSession,
} from '@/lib/route-access'
import { SUPPORT_COOKIE, verificarSupportToken } from '@/lib/support-token'

/**
 * Proxy de Next 16 (lo que hasta la v15 se llamaba `middleware`).
 *
 * ─── NO CONSULTA LA BASE DE DATOS. NUNCA. ────────────────────────────────
 *
 * Y es la propiedad más importante de este archivo.
 *
 * El proxy se despliega DISTRIBUIDO: corre en la región más cercana al
 * usuario, no donde estén las funciones. Medido en producción, sobre el mismo
 * despliegue:
 *
 *     proxy   → gru1   (São Paulo)
 *     función → cle1   (Cleveland, us-east-2, pegada a Neon)
 *
 * Y `vercel.json → regions` no lo cambia: eso solo mueve las Vercel
 * Functions. Así que cuando el proxy consultaba la sesión, esa consulta
 * cruzaba São Paulo → Ohio en CADA navegación: ~120-140 ms, el gasto mayor de
 * toda la aplicación, por delante de cualquier consulta de pantalla.
 *
 * Ahora decide con lo que viene FIRMADO:
 *   · el JWT de NextAuth  → identidad y rol del momento del login
 *   · el token de soporte → tenant suplantado y su caducidad propia
 *
 * ─── DÓNDE QUEDÓ EL ENFORCEMENT ──────────────────────────────────────────
 *
 * Donde siempre estuvo: en la base, al renderizar y al escribir.
 *
 *   · `(dashboard)/layout.tsx`  → usuario desactivado, sesión revocada por
 *     cambio de contraseña, tenant suspendido. Redirige.
 *   · `(superadmin)/layout.tsx` → `requireSuperAdmin()` contra la base;
 *     notFound() si el rol real no lo es.
 *   · cada página y cada Server Action → `requireTenantContext()`, que lee
 *     el rol y el estado de cuenta de la base.
 *   · `getTenantPrisma()` → corta toda escritura en READ_ONLY o BLOCKED.
 *
 * Todos corren en `cle1`, a 2-6 ms de la base, y comparten UNA consulta
 * gracias a la memoización por render.
 *
 * Lo que cambió es DÓNDE se bloquea, no SI se bloquea. Un usuario
 * desactivado ya no recibe el 307 del proxy: recibe el redirect del layout.
 * Llega un paso más lejos y sigue sin ver nada que no deba ver.
 *
 * `tests/proxy-sin-bd.ts` lo verifica, incluida una prueba estructural que
 * hace fallar la suite si alguna ruta o Server Action se salta la
 * comprobación contra la base.
 *
 * Toda la política vive en `resolveRouteAccessFromToken`, que es pura y está
 * testeada. Este archivo solo la conecta con el request.
 */
export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl

  /**
   * Atajo sin NADA de E/S para las rutas que no dependen de la sesión.
   *
   * Es lo que quita el bloqueo del login: la POST a
   * /api/auth/callback/credentials ni siquiera descifra el token.
   */
  if (!requiresSessionLookup(pathname)) {
    return NextResponse.next()
  }

  const t0 = performance.now()

  // Descifrar el JWT es criptografía local: no sale de la región.
  const jwt = await auth()
  const tJwt = performance.now()

  /*
   * El token de soporte lleva su caducidad dentro y firmada, así que una
   * sesión de soporte vencida se corta aquí sin consultar nada. Se exige que
   * la haya abierto ESTE usuario: un token robado sin la sesión no sirve.
   */
  const soporte = verificarSupportToken(req.cookies.get(SUPPORT_COOKIE)?.value)
  const soporteValido =
    soporte && jwt?.user?.id && soporte.superAdminId === jwt.user.id ? soporte : null

  const token: TokenSession | null = jwt?.user?.id
    ? {
        userId: jwt.user.id,
        role: jwt.user.role ?? 'VENDEDOR',
        ...(soporteValido ? { soporte: { tenantId: soporteValido.tenantId } } : {}),
      }
    : null

  const decision = resolveRouteAccessFromToken({ pathname, token })

  /*
   * `sesion_bd` se mantiene en la cabecera y debe salir SIEMPRE en 0. Si
   * alguna vez marca otra cosa, es que alguien volvió a meter una consulta
   * aquí, y eso se ve desde la pestaña de red sin leer código.
   */
  const timing = [
    `jwt;dur=${Math.round(tJwt - t0)}`,
    'sesion_bd;dur=0',
    `proxy_total;dur=${Math.round(performance.now() - t0)}`,
    `region;desc="${process.env.VERCEL_REGION ?? 'local'}"`,
  ].join(', ')

  if (decision.kind === 'redirect') {
    const redir = NextResponse.redirect(new URL(decision.to, req.url))
    redir.headers.set('Server-Timing', timing)
    return redir
  }

  /**
   * 404 por reescritura a una ruta inexistente, no `new NextResponse(null,
   * {status:404})`. La diferencia importa: una respuesta vacía se distingue a
   * simple vista de la página 404 de la app, y esa diferencia le confirma al
   * curioso que /superadmin recibe trato especial. Reescribiendo, el HTML es
   * exactamente el mismo que produce cualquier URL mal escrita.
   */
  if (decision.kind === 'not-found') {
    const nf = NextResponse.rewrite(new URL('/__ruta_inexistente__', req.url))
    nf.headers.set('Server-Timing', timing)
    return nf
  }

  const res = NextResponse.next()
  res.headers.set('Server-Timing', timing)
  return res
}

export const config = {
  /**
   * Se excluyen assets y estáticos: sin esto, cada imagen del catálogo
   * pasaría por aquí.
   *
   * `/api/auth` NO se excluye a propósito: `resolveRouteAccessFromToken` lo
   * trata como ruta pública, y dejarlo pasar por aquí mantiene la lista de
   * rutas públicas en un solo sitio en vez de repartida entre el matcher y
   * la política.
   */
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|webp|ico|woff2?)$).*)'],
}
