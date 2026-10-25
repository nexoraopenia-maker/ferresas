/*
 * Service Worker de FerreSaaS — CACHÉ ESTRICTA.
 *
 * Solo guarda ARCHIVOS ESTÁTICOS Y PÚBLICOS del propio origen: lo que Next compila en /_next/static/ (JS, CSS, fuentes, con
 * hash en el nombre) y los íconos / el logo de /public. Nada más:
 *
 *   · NUNCA HTML ni navegaciones: el contenido de una pantalla es de quien tenga la sesión, y en un celular compartido de
 *     mostrador la siguiente persona vería lo de la anterior.
 *   · NUNCA /api ni los datos de Server Actions / RSC (POST, o GET con `RSC`): son datos del negocio.
 *   · NUNCA se responde a nada que no sea GET del mismo origen. Si una petición no está en la lista, el worker no la toca y
 *     va a la red como si no existiera.
 *
 * Tampoco hay escrituras sin conexión: el dinero y el stock son transaccionales y solo se mueven con red.
 *
 * Subir VERSION cuando cambie la política: al activarse, borra todas las cachés de versiones anteriores.
 */
const VERSION = 'v1'
const CACHE = `ferresaas-estaticos-${VERSION}`

const RUTAS_ESTATICAS = [/^\/_next\/static\//, /^\/icons\//, /^\/aima-logo\.jpg$/]
const EXTENSIONES = /\.(?:js|css|woff2?|png|jpg|jpeg|svg|webp|ico)$/

/** `true` solo para un GET estático, público y del mismo origen. Es la ÚNICA puerta de entrada a la caché. */
function esEstatica(request, origen) {
  if (request.method !== 'GET') return false
  const url = new URL(request.url)
  if (url.origin !== origen) return false
  if (url.search && !url.pathname.startsWith('/_next/static/')) return false
  if (request.mode === 'navigate' || request.destination === 'document') return false
  if (request.headers.has('RSC') || request.headers.has('Next-Router-State-Tree') || request.headers.has('Next-Action')) return false
  if (request.headers.has('Authorization')) return false
  if (url.pathname.startsWith('/api/')) return false
  return RUTAS_ESTATICAS.some((r) => r.test(url.pathname)) && EXTENSIONES.test(url.pathname)
}

/** Una respuesta solo se guarda si es un 200 «normal», sin `Set-Cookie` y de un tipo que no sea HTML. */
function esGuardable(response) {
  if (!response || response.status !== 200 || response.type !== 'basic') return false
  if (response.headers.has('Set-Cookie')) return false
  const tipo = response.headers.get('Content-Type') || ''
  return !/text\/html|application\/json|text\/x-component/i.test(tipo)
}

self.addEventListener('install', () => { self.skipWaiting() })

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((nombres) => Promise.all(nombres.filter((n) => n.startsWith('ferresaas-') && n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  if (!esEstatica(event.request, self.location.origin)) return   // sin respondWith: pasa a la red tal cual
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const guardada = await cache.match(event.request)
      if (guardada) return guardada
      const respuesta = await fetch(event.request)
      if (esGuardable(respuesta)) await cache.put(event.request, respuesta.clone())
      return respuesta
    }),
  )
})

/** Al cerrar sesión la app puede pedir vaciar todo (por si acaso: lo guardado ya es público). */
self.addEventListener('message', (event) => {
  if (event.data && event.data.tipo === 'vaciar') {
    event.waitUntil(caches.keys().then((n) => Promise.all(n.filter((x) => x.startsWith('ferresaas-')).map((x) => caches.delete(x)))))
  }
})
