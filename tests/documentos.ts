import { completarRuc, digitoVerificadorRuc, validarDni, validarDocumento, validarRuc } from '../src/lib/documentos'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}

console.log('\n1) RUC públicos conocidos (contraste independiente del algoritmo)')
check('>>> el RUC de SUNAT, 20131312955, es válido', validarRuc('20131312955').valido)
check('>>> el de Supermercados Peruanos, 20100070970, es válido', validarRuc('20100070970').valido)
check('cambiar un dígito lo invalida', !validarRuc('20131312956').valido)

console.log('\n2) Errores de tecleo')
const r = (s: string) => validarRuc(s)
check('largo incorrecto', (r('2013131295') as { motivo?: string }).motivo === 'LONGITUD')
check('con letras', (r('2013131295A') as { motivo?: string }).motivo === 'NO_NUMERICO')
check('prefijo inexistente (30…)', (r(completarRuc('3013131295')) as { motivo?: string }).motivo === 'PREFIJO')
check('dígito verificador mal', (r('20131312950') as { motivo?: string }).motivo === 'DIGITO_VERIFICADOR')
check('espacios alrededor se toleran', validarRuc(' 20131312955 ').valido)
check('>>> transponer dos dígitos casi siempre se detecta',
  (() => { const base = '20131312955'; let det = 0, tot = 0
    for (let i = 0; i < 9; i++) { if (base[i] === base[i + 1]) continue; tot++
      const t = base.slice(0, i) + base[i + 1] + base[i] + base.slice(i + 2); if (!validarRuc(t).valido) det++ }
    return tot > 0 && det === tot })())

console.log('\n3) completarRuc genera RUC válidos (sirve para datos de prueba)')
check('10 dígitos → RUC válido', validarRuc(completarRuc('2051234567')).valido)
check('el verificador siempre es un dígito 0-9',
  Array.from({ length: 500 }, (_, i) => digitoVerificadorRuc(`20${String(i * 7919).padStart(8, '0').slice(0, 8)}`)).every((d) => d >= 0 && d <= 9))
check('exige 10 dígitos', (() => { try { digitoVerificadorRuc('123'); return false } catch { return true } })())

console.log('\n4) DNI y el documento por su largo')
check('8 dígitos = DNI válido', validarDni('41235678').valido)
check('7 dígitos no', !validarDni('4123567').valido)
check('con letras no', !validarDni('4123567A').valido)
check('validarDocumento: 8 → DNI', validarDocumento('41235678').tipo === 'DNI')
check('validarDocumento: 11 → RUC', validarDocumento('20131312955').tipo === 'RUC' && validarDocumento('20131312955').valido)
check('validarDocumento: 9 dígitos se rechaza', !validarDocumento('123456789').valido)

console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
process.exit(fail === 0 ? 0 : 1)
