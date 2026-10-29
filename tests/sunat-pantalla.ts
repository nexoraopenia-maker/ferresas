import { existsSync, readFileSync } from 'node:fs'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { SunatConfig, type EstadoSunatVista } from '../src/features/invoicing/components/SunatConfig'
import { CertificadoAlertBar } from '../src/features/invoicing/components/CertificadoAlertBar'
import { guardarCredencialesSunatAction } from '../src/features/invoicing/actions'

/**
 * S2 · La pantalla «Conexión con SUNAT» y la barra de vencimiento, renderizadas AISLADAS, y las páginas leídas como código. Lo que más importa: los pasos son claros,
 * ningún campo muestra un secreto (son de «contraseña» y se borran al guardar), la clave maestra ausente deshabilita todo con una explicación, el aviso de vencimiento sale
 * con los días que quedan, y el PSE (URL y Token) ya no está en pantalla.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const noop = () => undefined
const stub = { push: noop, replace: noop, refresh: noop, back: noop, forward: noop, prefetch: noop }
const html = (el: ReactElement) => renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: stub as never }, el))
const src = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '')
const sinComentarios = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const vacio: EstadoSunatVista = { configurado: false, ambiente: null, usuarioSol: null, certificado: null, ultimaPrueba: null }
const listo = (o: Partial<EstadoSunatVista> = {}): EstadoSunatVista => ({
  configurado: true, ambiente: 'BETA', usuarioSol: 'USERSOL1', ultimaPrueba: null,
  certificado: { sujeto: 'CN=FERRETERIA TITULAR SAC', ruc: '20123456789', vence: '2027-08-01', estado: 'vigente', diasRestantes: 280 }, ...o,
})
const pantalla = (estado: EstadoSunatVista, o: { claveMaestra?: boolean; puedeOperar?: boolean } = {}) =>
  html(createElement(SunatConfig, { estado, claveMaestra: o.claveMaestra ?? true, puedeOperar: o.puedeOperar ?? true }))

async function main() {
console.log('\nA) Sin configurar')
const a = pantalla(vacio)
check('>>> muestra los TRES pasos (certificado, usuario SOL secundario, probar) y que falta configurar', ['data-sunat-paso="1"', 'data-sunat-paso="2"', 'data-sunat-paso="3"'].every((x) => a.includes(x)) && a.includes('Certificado digital') && a.includes('Usuario SOL secundario') && a.includes('Probar la conexión') && a.includes('Sin configurar'))
check('>>> pide el .pfx/.p12, su clave, el usuario SOL y su clave', /type="file"[^>]*accept="[^"]*\.pfx/.test(a) && a.includes('Clave del certificado') && a.includes('Usuario SOL secundario') && a.includes('Clave SOL'))
check('>>> las dos claves son campos de CONTRASEÑA (no se ven ni se autocompletan)', (a.match(/type="password"/g) ?? []).length === 2 && (a.match(/autoComplete="new-password"/g) ?? []).length === 2)
check('>>> advierte que el usuario SOL debe ser secundario (nunca el principal)', /secundario/.test(a) && /Nunca uses el usuario principal/.test(a))
check('>>> el botón «Guardar» empieza deshabilitado (faltan datos)', /<button[^>]*data-boton="guardar-sunat"[^>]*disabled/.test(a) || /disabled=""[^>]*data-boton="guardar-sunat"/.test(a))
check('>>> ya no pide URL ni Token de un intermediario', !/URL del proveedor|Token del proveedor|proveedor de facturación|PSE/i.test(a))

console.log('\nB) Configurado')
const b = pantalla(listo({ ultimaPrueba: { en: '2026-10-30T12:00:00.000Z', ok: true, mensaje: 'SUNAT aceptó las credenciales y el certificado está vigente.' } }))
check('>>> enseña el titular, el usuario SOL, el estado «Vigente» y cuánto falta', b.includes('FERRETERIA TITULAR SAC') && b.includes('USERSOL1') && b.includes('Vigente') && b.includes('280 días') && b.includes('2027-08-01'))
check('>>> ofrece probar, cambiar y quitar; ya no muestra el formulario', ['data-boton="probar-sunat"', '>Cambiar<', '>Quitar<'].every((x) => b.includes(x)) && !b.includes('data-sunat="formulario"'))
check('>>> el paso 3 figura hecho con el resultado de la última prueba', /data-sunat-paso="3"[\s\S]{0,400}\(hecho\)/.test(b) && b.includes('SUNAT aceptó las credenciales'))
check('>>> avisa que es el ambiente de PRUEBAS (sin validez tributaria)', b.includes('Ambiente de PRUEBAS') && /no tiene validez tributaria/.test(b))
check('>>> no hay ningún campo con valor (nada de lo guardado vuelve a la pantalla)', !/<input[^>]*value="[^"]+"/.test(b))
const c = pantalla(listo({ ultimaPrueba: { en: '2026-10-30T12:00:00.000Z', ok: false, mensaje: 'SUNAT no aceptó el usuario SOL o su clave.' } }))
check('>>> una prueba fallida se dice (rojo) y el paso 3 NO figura hecho', c.includes('falló') && c.includes('SUNAT no aceptó el usuario SOL') && !/data-sunat-paso="3"[\s\S]{0,400}\(hecho\)/.test(c))
check('>>> sin prueba: «Aún no se probó» y aclara que no envía nada', pantalla(listo()).includes('Aún no se probó') && pantalla(listo()).includes('No envía ni emite nada'))

console.log('\nC) Estados del certificado')
const est = (estado: 'por_vencer' | 'vencido' | 'aun_no_vigente', dias: number) => pantalla(listo({ certificado: { sujeto: 'CN=X', ruc: null, vence: '2026-11-05', estado, diasRestantes: dias } }))
check('>>> por vencer: «Por vencer» y los días', est('por_vencer', 6).includes('Por vencer') && est('por_vencer', 6).includes('6 días') && est('por_vencer', 1).includes('1 día)'))
check('>>> vencido: lo dice y avisa que sin él no se emite', est('vencido', -3).includes('Vencido') && /venció el 2026-11-05/.test(est('vencido', -3)) && /sin él no se puede emitir/.test(est('vencido', -3)))
check('>>> aún no vigente', est('aun_no_vigente', 40).includes('Aún no vigente') && /empieza a valer/.test(est('aun_no_vigente', 40)))

console.log('\nD) Permisos y clave maestra')
const sinClave = pantalla(vacio, { claveMaestra: false })
check('>>> sin clave maestra en el servidor se explica y no se ofrece guardar nada', /falta la clave de cifrado/.test(sinClave) && !sinClave.includes('data-sunat="formulario"') && !sinClave.includes('type="file"'))
const soloLeer = pantalla(listo(), { puedeOperar: false })
check('>>> en solo lectura se ve el estado pero no hay botones ni formulario', soloLeer.includes('FERRETERIA TITULAR SAC') && !soloLeer.includes('data-boton="probar-sunat"') && !soloLeer.includes('type="file"'))

console.log('\nE) Barra de vencimiento')
const barra = (estado: Parameters<typeof CertificadoAlertBar>[0]['estado'], dias: number) => html(createElement(CertificadoAlertBar, { estado, diasRestantes: dias }))
check('>>> vigente: no hay barra', barra('vigente', 200) === '')
check('>>> por vencer: alerta con los días que quedan y enlace a Comprobantes', /role="alert"/.test(barra('por_vencer', 12)) && barra('por_vencer', 12).includes('vence en 12 días') && barra('por_vencer', 12).includes('href="/comprobantes"') && barra('por_vencer', 1).includes('1 día.'))
check('>>> vencido: lo dice sin rodeos (no se pueden emitir comprobantes)', /está vencido: no se pueden emitir comprobantes/.test(barra('vencido', -2)))
check('>>> aún no vigente', /todavía no está vigente/.test(barra('aun_no_vigente', 30)))

console.log('\nF) Cableado (leído como código)')
const pagina = src('src/app/(dashboard)/comprobantes/page.tsx'), layout = src('src/app/(dashboard)/layout.tsx'), actions = src('src/features/invoicing/actions.ts')
check('>>> la página de Comprobantes usa SunatConfig, solo con config.fiscal, y pasa solo metadatos (nunca *Enc ni claves)', /<SunatConfig/.test(pagina) && /puedeSeries = puede\(ctx, 'config\.fiscal'\)/.test(pagina) && /sunat = puedeSeries \? await estadoCredencialesSunat/.test(pagina) && !/pfx|Enc\b|claveSol|solPassword/i.test(sinComentarios(pagina)))
check('>>> el PSE (URL y Token) ya no está en pantalla: sin PseConfig, sin sus acciones', !existsSync('src/features/invoicing/components/PseConfig.tsx') && !/PseConfig|estadoConfigPse/.test(pagina) && !/guardarProveedorPse|quitarProveedorPse|probarProveedorPse/.test(actions))
check('>>> la barra de vencimiento solo se calcula y se muestra a quien tiene config.fiscal', /puede\(ctx, 'config\.fiscal'\) \? await alertaDeCertificado\(db\)/.test(layout) && /alertaCert && <CertificadoAlertBar/.test(layout))
check('>>> las acciones validan con zod ANTES de la sesión y el servicio decide el permiso', /guardarCredencialesSunatSchema\.safeParse/.test(actions) && actions.indexOf('guardarCredencialesSunatSchema.safeParse') < actions.indexOf("withTenant('guardarCredencialesSunatAction'"))
check('>>> guardar devuelve solo la fecha de vencimiento (ningún secreto)', /data: \{ vence: estado\.certificado\?\.vence\.toISOString\(\) \?\? null \}/.test(actions))
const comp = src('src/features/invoicing/components/SunatConfig.tsx')
check('>>> la pantalla borra del navegador el archivo y las claves apenas guarda, y rechaza archivos de más de 100 KB', /limpiar\(\); setEditando\(false\)/.test(comp) && /f\.size > 100 \* 1024/.test(comp))
const mala = await guardarCredencialesSunatAction({ pfxBase64: 'corto', claveCertificado: '', usuarioSol: 'ab', claveSol: 'x' })
check('>>> una entrada inválida se rechaza como VALIDATION antes de tocar sesión o base', !mala.ok && mala.code === 'VALIDATION')
check('>>> los textos de la pantalla no hablan de normas no confirmadas como si lo fueran', !/homologad[oa]\b.*\bya\b/i.test(comp))

}

main().then(() => {
  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  process.exit(fail === 0 ? 0 : 1)
}).catch((e) => { console.log(`  ✗ EXCEPCIÓN no controlada: ${e instanceof Error ? e.stack : e}`); process.exit(1) })
