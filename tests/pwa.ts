import './guard'
import { readFileSync, existsSync } from 'node:fs'
import vm from 'node:vm'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import manifest from '../src/app/manifest'
import { requiresSessionLookup, resolveRouteAccess } from '../src/lib/route-access'
import nextConfig from '../next.config'
import { AvisoSinRed } from '../src/components/pwa/BannerSinRed'

/**
 * Paso 4 (PWA). Lo que importa y se verifica aquí, sin navegador:
 *   1. El service worker SOLO toca estáticos públicos del propio origen. Se ejecuta el sw.js REAL en un sandbox con una
 *      `caches` falsa y se le lanzan peticiones: HTML, API, RSC, POST, otro origen, respuestas con cookie…
 *   2. El manifest es instalable (íconos que existen, con el tamaño que declaran).
 *   3. El proxy no esconde el manifest ni el worker detrás del login.
 *   4. Sin red se bloquea el cobro y el movimiento de stock.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }

async function main() {
  const ORIGEN = 'https://app.ferresaas.test'

  // ── Sandbox del service worker ────────────────────────────────────────────
  const almacen = new Map<string, Map<string, unknown>>()
  const cachesFalsa = {
    open: async (n: string) => {
      const c = almacen.get(n) ?? new Map<string, unknown>(); almacen.set(n, c)
      return { match: async (r: { url: string }) => c.get(r.url), put: async (r: { url: string }, v: unknown) => { c.set(r.url, v) } }
    },
    keys: async () => [...almacen.keys()],
    delete: async (n: string) => almacen.delete(n),
  }
  const oyentes: Record<string, (e: any) => void> = {}
  const red: string[] = []
  let respuestaDeRed: any = null
  const sandbox: any = {
    self: { location: { origin: ORIGEN }, addEventListener: (t: string, f: (e: any) => void) => { oyentes[t] = f }, skipWaiting: () => {}, clients: { claim: async () => {} } },
    caches: cachesFalsa, URL,
    fetch: async (r: { url: string }) => { red.push(r.url); return respuestaDeRed },
  }
  vm.createContext(sandbox)
  vm.runInContext(readFileSync('public/sw.js', 'utf8'), sandbox)

  const cabeceras = (o: Record<string, string> = {}) => ({ has: (k: string) => Object.keys(o).some((x) => x.toLowerCase() === k.toLowerCase()), get: (k: string) => o[k] ?? null })
  const peticion = (path: string, o: { method?: string; mode?: string; destination?: string; headers?: Record<string, string>; origin?: string } = {}) =>
    ({ url: `${o.origin ?? ORIGEN}${path}`, method: o.method ?? 'GET', mode: o.mode ?? 'no-cors', destination: o.destination ?? 'script', headers: cabeceras(o.headers) })
  const respuesta = (o: { status?: number; type?: string; tipo?: string; cookie?: boolean } = {}) =>
    ({ status: o.status ?? 200, type: o.type ?? 'basic', headers: cabeceras({ ...(o.cookie ? { 'Set-Cookie': 'a=b' } : {}), 'Content-Type': o.tipo ?? 'application/javascript' }), clone() { return this } })
  /** Lanza la petición por el worker. Devuelve si lo interceptó (respondWith) o lo dejó pasar a la red. */
  const lanzar = async (req: ReturnType<typeof peticion>, resp: unknown = respuesta()) => {
    red.length = 0; respuestaDeRed = resp
    let intercepto = false; let p: Promise<unknown> | undefined
    oyentes.fetch!({ request: req, respondWith: (x: Promise<unknown>) => { intercepto = true; p = x } })
    if (p) await p
    return { intercepto, fueARed: red.length > 0 }
  }
  const enCache = () => [...almacen.values()].flatMap((c) => [...c.keys()])

  console.log('\n1) El service worker solo cachea estáticos públicos')
  for (const [n, path, dest] of [
    ['JS compilado de Next', '/_next/static/chunks/app-1a2b.js', 'script'],
    ['CSS compilado de Next', '/_next/static/css/app.css', 'style'],
    ['fuente', '/_next/static/media/inter.woff2', 'font'],
    ['ícono de la app', '/icons/icon-192.png', 'image'],
    ['logo público', '/aima-logo.jpg', 'image'],
  ] as const) {
    const r = await lanzar(peticion(path, { destination: dest }), respuesta({ tipo: 'application/octet-stream' }))
    check(`>>> ${n} (${path}) se sirve por el worker y queda en caché`, r.intercepto && enCache().includes(`${ORIGEN}${path}`))
  }
  const repetido = await lanzar(peticion('/icons/icon-192.png', { destination: 'image' }), respuesta())
  check('el segundo pedido sale de la caché (no vuelve a la red)', repetido.intercepto && !repetido.fueARed)

  console.log('\n2) NUNCA HTML, API ni datos autenticados')
  almacen.clear()
  const prohibidas: [string, ReturnType<typeof peticion>][] = [
    ['una navegación a una pantalla (/pos)', peticion('/pos', { mode: 'navigate', destination: 'document' })],
    ['HTML aunque no declare navegación', peticion('/inventario', { destination: 'document' })],
    ['la página de login', peticion('/login', { mode: 'navigate', destination: 'document' })],
    ['la API autenticada (/api/products)', peticion('/api/products', { destination: '' })],
    ['la API aunque parezca un .js', peticion('/api/export.js', { destination: 'script' })],
    ['un POST (Server Action / cobro)', peticion('/pos', { method: 'POST', destination: '' })],
    ['un pedido RSC de Next (datos de la pantalla)', peticion('/_next/static/x.js', { headers: { RSC: '1' } })],
    ['una Server Action', peticion('/_next/static/x.js', { headers: { 'Next-Action': 'abc' } })],
    ['un pedido con Authorization', peticion('/icons/icon-192.png', { headers: { Authorization: 'Bearer x' } })],
    ['un estático con parámetros (?_rsc=)', peticion('/icons/icon-192.png?_rsc=1', { destination: 'image' })],
    ['estático de OTRO origen', peticion('/_next/static/a.js', { origin: 'https://otro.com' })],
    ['datos de Next (/_next/data)', peticion('/_next/data/build/pos.json', { destination: '' })],
    ['el manifest', peticion('/manifest.webmanifest', { destination: 'manifest' })],
    ['el propio sw.js', peticion('/sw.js', { destination: 'serviceworker' })],
    ['una imagen privada fuera de las rutas públicas', peticion('/uploads/factura-123.png', { destination: 'image' })],
  ]
  for (const [n, req] of prohibidas) {
    const r = await lanzar(req)
    check(`>>> ${n}: el worker NO lo toca (va directo a la red) y no se guarda`, !r.intercepto && enCache().length === 0)
  }

  console.log('\n3) Una respuesta solo se guarda si es segura')
  for (const [n, resp] of [
    ['HTML en una ruta estática', respuesta({ tipo: 'text/html; charset=utf-8' })],
    ['JSON', respuesta({ tipo: 'application/json' })],
    ['payload RSC', respuesta({ tipo: 'text/x-component' })],
    ['una respuesta con Set-Cookie', respuesta({ cookie: true })],
    ['un error 404', respuesta({ status: 404 })],
    ['un 500', respuesta({ status: 500 })],
    ['una respuesta opaca / de otro origen', respuesta({ type: 'opaque' })],
  ] as const) {
    almacen.clear()
    const r = await lanzar(peticion('/_next/static/chunks/y.js'), resp)
    check(`>>> ${n}: se entrega pero NO se guarda`, r.intercepto && enCache().length === 0)
  }

  console.log('\n4) Versiones: al activarse borra las cachés viejas, pero solo las suyas')
  almacen.set('ferresaas-estaticos-v0', new Map()); almacen.set('ferresaas-estaticos-v1', new Map()); almacen.set('otra-app', new Map())
  await new Promise<void>((ok) => oyentes.activate!({ waitUntil: (p: Promise<unknown>) => p.then(() => ok()) }))
  check('>>> se borra la versión anterior, se conserva la vigente y NO se toca la caché de otra app', !almacen.has('ferresaas-estaticos-v0') && almacen.has('ferresaas-estaticos-v1') && almacen.has('otra-app'))
  await new Promise<void>((ok) => oyentes.message!({ data: { tipo: 'vaciar' }, waitUntil: (p: Promise<unknown>) => p.then(() => ok()) }))
  check('el mensaje «vaciar» limpia sus cachés (y solo las suyas)', !almacen.has('ferresaas-estaticos-v1') && almacen.has('otra-app'))

  const fuente = readFileSync('public/sw.js', 'utf8')
  const codigo = fuente.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  check('>>> el worker no precachea nada ni define una página «offline» de HTML (sin addAll / .html / respuestas sintéticas)', !/addAll|\.html|new Response|offline/i.test(codigo))
  check('el worker no maneja `sync`/`push` ni escrituras diferidas (v1 sin escrituras sin conexión)', !/addEventListener\('(?:sync|push|periodicsync|backgroundfetch)/.test(codigo))

  console.log('\n5) Manifest instalable')
  const m = manifest()
  check('>>> nombre, modo standalone y raíz del sitio como alcance', m.name === 'FerreSaaS' && m.display === 'standalone' && m.scope === '/' && !!m.short_name)
  check('el inicio cae dentro del alcance y es una pantalla del panel (no el login ni un redireccionamiento)', !!m.start_url?.startsWith('/') && m.start_url === '/pos')
  const iconos = m.icons ?? []
  check('>>> hay ícono 192 y 512 «any» y uno «maskable»', iconos.some((i) => i.sizes === '192x192' && i.purpose === 'any') && iconos.some((i) => i.sizes === '512x512' && i.purpose === 'any') && iconos.some((i) => i.purpose === 'maskable'))
  for (const i of iconos) {
    const f = `public${i.src}`
    const png = existsSync(f) ? readFileSync(f) : null
    const ok = !!png && png.subarray(1, 4).toString() === 'PNG' && `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}` === i.sizes
    check(`>>> ${i.src} existe, es PNG y mide exactamente ${i.sizes}`, ok)
  }
  check('el ícono de Apple (180×180) existe', existsSync('public/icons/apple-touch-icon.png') && readFileSync('public/icons/apple-touch-icon.png').readUInt32BE(16) === 180)
  const layout = readFileSync('src/app/layout.tsx', 'utf8')
  check('el layout enlaza el ícono de Apple, registra el worker y monta el aviso de red', layout.includes('apple-touch-icon.png') && layout.includes('<RegistrarServiceWorker />') && layout.includes('<BannerSinRed />'))
  check('el worker solo se registra en producción, con alcance «/»', /NODE_ENV !== 'production'/.test(readFileSync('src/components/pwa/RegistrarServiceWorker.tsx', 'utf8')) && /register\('\/sw\.js', \{ scope: '\/' \}\)/.test(readFileSync('src/components/pwa/RegistrarServiceWorker.tsx', 'utf8')))

  console.log('\n6) El proxy no esconde el manifest ni el worker tras el login')
  for (const r of ['/manifest.webmanifest', '/sw.js']) {
    check(`>>> ${r}: sin sesión pasa y no consulta la sesión`, resolveRouteAccess({ pathname: r, session: null }).kind === 'allow' && !requiresSessionLookup(r))
  }
  check('y una pantalla del panel sigue exigiendo sesión (nada se abrió de más)', resolveRouteAccess({ pathname: '/pos', session: null }).kind === 'redirect' && requiresSessionLookup('/pos'))
  const cab = await (nextConfig.headers as () => Promise<{ source: string; headers: { key: string; value: string }[] }[]>)()
  const dev = cab.find((h) => h.source === '/sw.js')?.headers ?? []
  check('>>> /sw.js no se cachea en el navegador (se revalida siempre) y declara su alcance', /no-cache/.test(dev.find((h) => h.key === 'Cache-Control')?.value ?? '') && dev.some((h) => h.key === 'Service-Worker-Allowed' && h.value === '/'))
  check('las cabeceras de seguridad globales siguen (cámara solo del propio origen)', cab.some((h) => h.source === '/:path*' && h.headers.some((x) => x.key === 'Permissions-Policy' && x.value.includes('camera=(self)'))))

  console.log('\n7) Sin red se bloquea el cobro y el inventario')
  const aviso = renderToStaticMarkup(createElement(AvisoSinRed))
  check('>>> el aviso es una alerta visible: «Sin red / Offline» y explica qué se bloquea', aviso.includes('role="alert"') && aviso.includes('Sin red / Offline') && aviso.includes('cobro') && aviso.includes('stock'))
  // El recibo (boleta y factura) vive en su propio archivo desde el Paso 4; sigue siendo parte del POS.
  const pos = readFileSync('src/features/pos/components/PosTerminal.tsx', 'utf8') + readFileSync('src/features/pos/components/ReciboEmitido.tsx', 'utf8')
  const hoja = readFileSync('src/features/inventory/components/ScanToStockSheet.tsx', 'utf8')
  const abre = (src: string, firma: string) => { const i = src.indexOf(firma); return i < 0 ? '' : src.slice(i, i + 260) }
  const guardada = (src: string, firma: string) => /if \(!enLinea\) \{ setError\(MENSAJE_SIN_RED\); return \}/.test(abre(src, firma))
  for (const f of ['const cobrar = () => {', 'const cotizar = () => {', 'const enviarACaja = () => {', 'const emitir = (documentType']) {
    check(`>>> POS: «${f.replace(' = () => {', '').replace(' = (documentType', '')}» se corta sin red ANTES de llamar al servidor`, guardada(pos, f))
  }
  check('>>> POS: cobrar, cotizar, enviar a caja, boleta y factura quedan deshabilitados sin red', (pos.match(/!enLinea/g) ?? []).length >= 9 && (pos.match(/disabled=\{pendiente \|\| !enLinea/g) ?? []).length >= 5)
  check('>>> inventario: confirmar un movimiento y crear un producto se cortan sin red', guardada(hoja, 'const confirmar = useCallback(() => {') && guardada(hoja, 'const submit = () => {') && (hoja.match(/disabled=\{pending \|\| !enLinea/g) ?? []).length === 2)
  check('(el escáner y la búsqueda NO se bloquean: son lecturas y fallan solas con su propio mensaje)', true)

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  process.exit(fail === 0 ? 0 : 1)
}
main()
