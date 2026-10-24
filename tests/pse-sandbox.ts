import { evaluarHostSandbox, hostsSandbox } from '../src/features/invoicing/sandbox-hosts'
import { readFileSync } from 'node:fs'

/** Barrera PSE_SANDBOX_HOSTS: pura, sin base ni red. */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const E = (v?: string) => ({ PSE_SANDBOX_HOSTS: v })

console.log('\n1) Denegar por defecto')
check('>>> sin la variable → NO se envía a ningún host', !evaluarHostSandbox('https://sandbox.proveedor.pe', E(undefined)).ok)
check('variable vacía o solo comas → NO', !evaluarHostSandbox('https://sandbox.proveedor.pe', E('')).ok && !evaluarHostSandbox('https://sandbox.proveedor.pe', E(' , ,')).ok)
check('sin URL del proveedor → NO', !evaluarHostSandbox(null, E('sandbox.proveedor.pe')).ok && !evaluarHostSandbox('', E('sandbox.proveedor.pe')).ok)

console.log('\n2) Solo el host EXACTO')
check('el host declarado → sí', evaluarHostSandbox('https://sandbox.proveedor.pe/v1', E('sandbox.proveedor.pe')).ok)
check('mayúsculas y espacios no importan; varios hosts', evaluarHostSandbox('https://SANDBOX.proveedor.pe', E(' otro.pe , Sandbox.Proveedor.PE ')).ok)
check('>>> el host de PRODUCCIÓN del mismo proveedor → NO (api.proveedor.pe ≠ sandbox.proveedor.pe)', !evaluarHostSandbox('https://api.proveedor.pe', E('sandbox.proveedor.pe')).ok)
check('>>> un subdominio o un dominio más largo → NO (sin sufijos)', !evaluarHostSandbox('https://x.sandbox.proveedor.pe', E('sandbox.proveedor.pe')).ok && !evaluarHostSandbox('https://sandbox.proveedor.pe.malo.com', E('sandbox.proveedor.pe')).ok)
check('>>> el truco del usuario en la URL (https://sandbox.proveedor.pe@api.proveedor.pe) → NO', !evaluarHostSandbox('https://sandbox.proveedor.pe@api.proveedor.pe/', E('sandbox.proveedor.pe')).ok)
check('>>> http (no https) → NO', !evaluarHostSandbox('http://sandbox.proveedor.pe', E('sandbox.proveedor.pe')).ok)
check('URL ilegible → NO', !evaluarHostSandbox('no es una url', E('sandbox.proveedor.pe')).ok)

console.log('\n3) La variable mal escrita también se niega')
check('>>> comodín, ruta o puerto en la variable → NO', ['*.proveedor.pe', 'sandbox.proveedor.pe/v1', 'sandbox.proveedor.pe:443'].every((v) => !evaluarHostSandbox('https://sandbox.proveedor.pe', E(v)).ok))
check('el motivo no contiene el token ni la ruta', !evaluarHostSandbox('https://api.proveedor.pe/secreto?token=abc', E('sandbox.proveedor.pe')).motivo.includes('abc'))
check('hostsSandbox normaliza', JSON.stringify(hostsSandbox(E(' A.pe,B.PE ,'))) === JSON.stringify(['a.pe', 'b.pe']))

console.log('\n4) El script la usa ANTES de enviar')
const script = readFileSync('scripts/certificar-nota.ts', 'utf8')
const iBarrera = script.indexOf('evaluarHostSandbox(tenant.pseEndpointUrl)')
check('>>> certificar-nota.ts evalúa la barrera y para si no es sandbox', iBarrera > 0 && /if \(!sandbox\.ok\) parar\(/.test(script))
check('>>> y la evalúa ANTES de emitir la nota o tocar la cola', iBarrera > 0 && iBarrera < script.indexOf('emitirNotaCreditoTotal(db, ctx') && iBarrera < script.indexOf('reclamarPorId('))
check('la variable está documentada en .env.example', readFileSync('.env.example', 'utf8').includes('PSE_SANDBOX_HOSTS'))

console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
process.exit(fail === 0 ? 0 : 1)
