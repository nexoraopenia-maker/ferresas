import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ACCIONES, ACCIONES_QUE_NO_SON_AUDITORIA, accionesDe, CATEGORIAS, describirAccion } from '../src/features/auditoria/catalogo'
import { esClaveSensible, mostrarJson, OCULTO, redactar } from '../src/features/auditoria/redaccion'
import { enlaceAuditoria } from '../src/features/auditoria/urls'
import { parametrosAuditoriaSchema } from '../src/features/auditoria/schemas'

/**
 * F5.5 · Lo que se muestra del registro de auditoría: secretos tapados (aun anidados), catálogo completo, filtros por la dirección.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const J = (v: unknown) => JSON.stringify(redactar(v))

console.log('\nA) Redacción')
check('>>> se tapan contraseñas, tokens, certificados, claves SOL y secretos de API', ['password', 'passwordHash', 'pinHash', 'token', 'accessToken', 'client_secret', 'clientSecret', 'apiKey', 'api-key', 'pfx', 'certificado', 'certificatePassword', 'claveSol', 'usuarioSol', 'cvv', 'totpSecret', 'Authorization', 'cookie', 'privateKey', 'pin'].every(esClaveSensible))
check('>>> NO se tapan campos normales (así el registro sigue siendo útil)', ['total', 'solicitud', 'sku', 'nombre', 'cantidad', 'status', 'motivo', 'solicitadoPor', 'mapping', 'shipping', 'email', 'ruc', 'monto'].every((k) => !esClaveSensible(k)))
check('>>> el valor de una clave sensible se reemplaza, aunque esté anidado a varios niveles o dentro de un arreglo', J({ a: { b: [{ c: { token: 'abc123', ok: 1 } }] } }) === '{"a":{"b":[{"c":{"token":"«oculto»","ok":1}}]}}')
check('una clave sensible vacía o nula se deja como está (no se inventa un secreto)', J({ token: null, password: '' }) === '{"token":null,"password":""}')
check('>>> un texto que PARECE un token se tapa aunque su clave sea inocente (Bearer, JWT, llave privada)', J({ nota: 'Bearer abcdefghijklmnop', x: 'eyJhbGciOiJI.eyJzdWIiOiIx.SflKxwRJSM', k: '-----BEGIN PRIVATE KEY-----\nMIIE' }).split(OCULTO).length === 4)
check('los textos normales no se tocan; los muy largos se recortan', J({ n: 'Cemento' }) === '{"n":"Cemento"}' && String(redactar('x'.repeat(900))).length < 560)
check('arreglos grandes se recortan con aviso', (redactar(Array.from({ length: 80 }, (_, i) => i)) as unknown[]).length === 51)
check('una estructura circular o muy profunda no revienta', (() => { let o: Record<string, unknown> = {}; const raíz = o; for (let i = 0; i < 20; i++) { o.h = {}; o = o.h as Record<string, unknown> } return JSON.stringify(redactar(raíz)).includes('«…»') })())
check('null/undefined y números se conservan', redactar(null) === null && redactar(undefined) === null && redactar(5) === 5 && redactar(false) === false)
check('mostrarJson: nada que mostrar → null; con contenido, texto legible', mostrarJson(null) === null && mostrarJson({ a: 1 })!.texto.includes('"a": 1'))
check('>>> mostrarJson recorta por tamaño y lo dice, sin romper el JSON de arriba', (() => { const r = mostrarJson({ t: 'y'.repeat(400), l: Array.from({ length: 50 }, () => 'z'.repeat(100)) }, 500)!; return r.truncado && r.texto.length <= 505 })())
check('>>> mostrarJson nunca devuelve un secreto', !mostrarJson({ ok: 1, claveSol: 'SECRETO-123' })!.texto.includes('SECRETO'))

console.log('\nB) Catálogo')
check('cada acción conocida tiene una categoría válida y una etiqueta en español', Object.values(ACCIONES).every((a) => CATEGORIAS.includes(a.categoria) && a.etiqueta.length > 5))
check('>>> una acción desconocida NO se esconde: va a «Otros» con su código', (() => { const d = describirAccion('algo.nuevo'); return d.categoria === 'Otros' && d.etiqueta === 'algo.nuevo' })())
check('cada categoría salvo «Otros» tiene acciones', CATEGORIAS.filter((c) => c !== 'Otros').every((c) => accionesDe(c).length > 0) && accionesDe('Otros').length === 0)
const archivos = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? (f === 'generated' ? [] : archivos(p)) : /\.tsx?$/.test(f) ? [p] : [] })
const usadas = new Set<string>()
for (const f of archivos('src')) for (const m of readFileSync(f, 'utf8').matchAll(/\baction: '([A-Za-z0-9_.]+)'/g)) usadas.add(m[1]!)
const sinEtiqueta = [...usadas].filter((a) => !(a in ACCIONES) && !ACCIONES_QUE_NO_SON_AUDITORIA.includes(a))
check('>>> toda acción de auditoría que el código escribe tiene etiqueta (si añades una nueva, etiquétala en catalogo.ts)', sinEtiqueta.length === 0, sinEtiqueta.join(', '))
check('y el catálogo no guarda acciones que ya nadie escribe', Object.keys(ACCIONES).filter((a) => !usadas.has(a)).length === 0, Object.keys(ACCIONES).filter((a) => !usadas.has(a)).join(', '))

console.log('\nC) Filtros por la dirección')
const P = (o: Record<string, unknown> = {}) => parametrosAuditoriaSchema.safeParse(o)
check('sin nada: la última semana, todas las categorías', (() => { const r = P(); return r.success && r.data.p === 'SEMANA' && r.data.categoria === 'TODAS' })())
check('>>> categoría inventada, actor con caracteres raros y cursor mal formado se rechazan', !P({ categoria: 'Hackers' }).success && !P({ actor: "x'; drop" }).success && !P({ cursor: 'ayer' }).success && !P({ cursor: '2026-10-26T10:00:00.000Z|' }).success)
check('un cursor bien formado se acepta', P({ cursor: '2026-10-26T10:00:00.000Z|clx12345abc' }).success)
check('enlace por defecto limpio; con filtros solo lo no habitual', enlaceAuditoria({ p: 'SEMANA', categoria: 'TODAS' }) === '/auditoria' && enlaceAuditoria({ p: 'HOY', categoria: 'Clientes', actor: 'abc12345' }) === '/auditoria?p=HOY&categoria=Clientes&actor=abc12345')
check('el cursor viaja codificado y las fechas solo con RANGO', enlaceAuditoria({ p: 'RANGO', desde: '2026-10-01', hasta: '2026-10-05' }, '2026-10-26T10:00:00.000Z|abc12345').includes('desde=2026-10-01') && enlaceAuditoria({ p: 'MES', desde: '2026-10-01' }) === '/auditoria?p=MES' && enlaceAuditoria({}, '2026-10-26T10:00:00.000Z|abc12345').includes('cursor=2026-10-26T10%3A00%3A00.000Z%7Cabc12345'))

console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
process.exit(fail === 0 ? 0 : 1)
