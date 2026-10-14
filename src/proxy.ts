import { NextResponse, type NextRequest } from 'next/server'
import { auth } from '@/auth'
import { getRouteSession } from '@/lib/session'
import { requiresSessionLookup, resolveRouteAccess } from '@/lib/route-access'
import { IMPERSONATION_COOKIE } from '@/lib/impersonation'

/**
 * Proxy de Next 16 (lo que hasta la v15 se llamaba `middleware`).
 *
 * Next 16 deprecó el fichero `middleware.ts` en favor de `proxy.ts`, y con el
 * cambio el runtime dejó de ser configurable: el proxy corre SIEMPRE en
 * Node.js. Eso hace innecesaria la gimnasia habitual de Auth.js —partir la
 * config en una mitad "edge-safe" sin Prisma— porque aquí sí podemos
 * consultar la base directamente.
 *
 * Y eso importa: consultar el estado de la cuenta en cada navegación es lo
 * que permite que el JWT no cargue con la autorización. Una suscripción
 * cancelada surte efecto en la siguiente navegación, no cuando expire el
 * token (ver src/auth.ts).
 *
 * Toda la política vive en `resolveRouteAccess`, que es pura y está testeada.
 * Este archivo solo la conecta con el request.
 */
export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl

  /**
   * Atajo sin NADA de E/S para las rutas que no dependen de la sesión.
   *
   * Es lo que quita el bloqueo del login en Vercel: la POST a
   * /api/auth/callback/credentials ya no espera a que Neon despierte para
   * resolver una sesión que aún no existe. Se sale antes de tocar `auth()`
   * y antes de consultar la base.
   */
  if (!requiresSessionLookup(pathname)) {
    return NextResponse.next()
  }

  const token = await auth()
  const impersonationId = req.cookies.get(IMPERSONATION_COOKIE)?.value
  const session = token?.user?.id
    ? await getRouteSession(token.user.id, impersonationId, new Date(), token.issuedAt)
    : null

  const decision = resolveRouteAccess({ pathname, session })

  if (decision.kind === 'redirect') {
    const url = new URL(decision.to, req.url)
    return NextResponse.redirect(url)
  }

  /**
   * 404 por reescritura a una ruta inexistente, no `new NextResponse(null,
   * {status:404})`. La diferencia importa: una respuesta vacía se distingue a
   * simple vista de la página 404 de la app, y esa diferencia le confirma al
   * curioso que la ruta /superadmin recibe trato especial. Reescribiendo, el
   * HTML es exactamente el mismo que produce cualquier URL mal escrita.
   */
  if (decision.kind === 'not-found') {
    return NextResponse.rewrite(new URL('/__ruta_inexistente__', req.url))
  }

  // El banner ya NO se pinta desde aquí: lo resuelve AccountBannerBar con su
  // propia consulta, porque necesita días restantes y nombre de plan. La
  // cabecera se mantiene únicamente como señal de depuración.
  const res = NextResponse.next()
  if (decision.notice) {
    res.headers.set('x-account-notice', decision.notice)
  }
  return res
}

export const config = {
  /**
   * Se excluyen assets y estáticos: sin esto, cada imagen del catálogo
   * dispararía una consulta de sesión.
   *
   * `/api/auth` NO se excluye a propósito: `resolveRouteAccess` lo trata como
   * ruta pública, y dejarlo pasar por aquí mantiene la lista de rutas
   * públicas en un solo sitio en vez de repartida entre el matcher y la
   * política.
   */
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|webp|ico|woff2?)$).*)'],
}
