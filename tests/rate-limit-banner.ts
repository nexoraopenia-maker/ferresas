import { checkRateLimit, resetRateLimits, clientIp, RATE_RULES } from '@/lib/rate-limit'
import { getAccountBanner } from '@/features/billing/account-status'
import { toFormEncoded } from '@/features/billing/stripe-client'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}

async function main() {
  console.log('\n1) Rate limiter — ventana deslizante')
  resetRateLimits()
  const T = (s: number) => new Date(2026, 7, 25, 12, 0, s)
  const regla = { limit: 3, windowSeconds: 60 }

  for (let i = 0; i < 3; i++) {
    const r = await checkRateLimit('ip-a', regla, T(i))
    check(`intento ${i + 1} de 3 permitido (quedan ${r.remaining})`, r.ok)
  }
  const cuarto = await checkRateLimit('ip-a', regla, T(3))
  check('el cuarto se rechaza', !cuarto.ok)
  check('indica cuántos segundos esperar', cuarto.retryAfterSeconds === 57, `${cuarto.retryAfterSeconds}s`)

  check('otra IP no se ve afectada', (await checkRateLimit('ip-b', regla, T(3))).ok)

  console.log('\n2) Insistir NO alarga el castigo')
  for (let i = 0; i < 20; i++) await checkRateLimit('ip-a', regla, T(4 + i))
  // Los intentos rechazados no se registran, así que a los 60s del PRIMER
  // intento válido la ventana ya está libre.
  check('tras pasar la ventana vuelve a permitir',
    (await checkRateLimit('ip-a', regla, T(61))).ok)

  console.log('\n3) La ventana DESLIZA — el ataque de borde no funciona')
  // Con ventana FIJA por minuto, un atacante gasta su cupo al final de un
  // minuto y otro cupo entero al principio del siguiente: el doble del
  // límite en dos segundos. Se comprueba que aquí no ocurre.
  resetRateLimits()
  await checkRateLimit('ip-c', regla, T(57))
  await checkRateLimit('ip-c', regla, T(58))
  await checkRateLimit('ip-c', regla, T(59))
  check('cruzar el minuto NO regala un cupo nuevo',
    !(await checkRateLimit('ip-c', regla, T(61))).ok)
  check('sigue bloqueado a los 100s (los tres intentos aún viven)',
    !(await checkRateLimit('ip-c', regla, T(100))).ok)
  check('se libera cuando caducan los tres, no antes',
    (await checkRateLimit('ip-c', regla, T(118))).ok)

  console.log('\n4) Reglas reales del SaaS')
  resetRateLimits()
  check('registro permite 5/hora', RATE_RULES.register.limit === 5 && RATE_RULES.register.windowSeconds === 3600)
  const ahora = new Date()
  for (let i = 0; i < 5; i++) await checkRateLimit('register:1.2.3.4', RATE_RULES.register, ahora)
  check('el sexto registro desde la misma IP se corta',
    !(await checkRateLimit('register:1.2.3.4', RATE_RULES.register, ahora)).ok)

  console.log('\n5) Extracción de IP')
  check('toma la primera de x-forwarded-for',
    clientIp(new Headers({ 'x-forwarded-for': '203.0.113.9, 70.41.3.18' })) === '203.0.113.9')
  check('cae a x-real-ip', clientIp(new Headers({ 'x-real-ip': '198.51.100.7' })) === '198.51.100.7')
  check('nunca devuelve vacío', clientIp(new Headers()) === 'desconocida')

  console.log('\n6) Banner — trial')
  const base = { pastDueSince: null, graceDays: 7, planName: 'Pro' } as const
  const hoy = new Date('2026-08-25T12:00:00Z')
  const en = (d: number) => new Date(hoy.getTime() + d * 86400000)

  check('con 10 días de prueba NO molesta',
    getAccountBanner({ ...base, status: 'TRIALING', access: 'FULL', trialEndsAt: en(10) }, hoy) === null)
  {
    const b = getAccountBanner({ ...base, status: 'TRIALING', access: 'FULL', trialEndsAt: en(4) }, hoy)
    check('a 4 días avisa en tono informativo', b?.tone === 'info')
    check('y ofrece activar el plan', b?.cta === 'Activar mi plan')
  }
  {
    const b = getAccountBanner({ ...base, status: 'TRIALING', access: 'FULL', trialEndsAt: en(1) }, hoy)
    check('a 1 día sube a tono de aviso', b?.tone === 'warn')
    check('el texto usa singular', b?.title === 'Te queda 1 día de prueba', b?.title)
  }
  {
    const b = getAccountBanner({ ...base, status: 'TRIALING', access: 'FULL', trialEndsAt: hoy }, hoy)
    check('el último día lo dice claro', b?.title === 'Tu prueba termina hoy', b?.title)
  }

  console.log('\n7) Banner — mora y bloqueo')
  {
    const b = getAccountBanner({
      ...base, status: 'PAST_DUE', access: 'WARN',
      trialEndsAt: null, pastDueSince: new Date('2026-08-22T12:00:00Z'),
    }, hoy)
    check('en gracia cuenta los días que quedan', b?.daysLeft === 4, String(b?.daysLeft))
    check('con tono de aviso, no de bloqueo', b?.tone === 'warn')
  }
  {
    const b = getAccountBanner({ ...base, status: 'PAST_DUE', access: 'READ_ONLY', trialEndsAt: null }, hoy)
    check('vencida -> solo lectura en rojo', b?.tone === 'stop' && b?.title === 'Solo lectura')
    check('explica qué se puede y qué no', /consultar/.test(b?.body ?? '') && /no registrar/.test(b?.body ?? ''))
  }
  {
    const b = getAccountBanner({ ...base, status: 'CANCELED', access: 'READ_ONLY', trialEndsAt: null }, hoy)
    check('cancelada explica el motivo correcto', /cancelada/.test(b?.body ?? ''), b?.body)
  }
  {
    const b = getAccountBanner({ ...base, status: 'TRIALING', access: 'READ_ONLY', trialEndsAt: en(-1) }, hoy)
    check('trial agotado dice "prueba gratuita terminó"', /prueba gratuita terminó/.test(b?.body ?? ''))
  }
  {
    const b = getAccountBanner({ ...base, status: 'ACTIVE', access: 'BLOCKED', trialEndsAt: null }, hoy)
    check('suspendida no ofrece pagar (pagar no la levanta)', b?.cta === null)
  }
  check('cuenta sana no muestra banner',
    getAccountBanner({ ...base, status: 'ACTIVE', access: 'FULL', trialEndsAt: null }, hoy) === null)

  console.log('\n8) Codificación de formularios para Stripe')
  check('anida arrays con corchetes',
    toFormEncoded({ line_items: [{ price: 'price_1', quantity: 1 }] }) ===
      'line_items%5B0%5D%5Bprice%5D=price_1&line_items%5B0%5D%5Bquantity%5D=1')
  check('anida objetos',
    toFormEncoded({ subscription_data: { metadata: { tenantId: 't1' } } }) ===
      'subscription_data%5Bmetadata%5D%5BtenantId%5D=t1')
  check('omite undefined y null',
    toFormEncoded({ a: '1', b: undefined, c: null }) === 'a=1')
  check('escapa caracteres de la URL de retorno',
    toFormEncoded({ success_url: 'https://x.com/f?a=1&b=2' }) ===
      'success_url=https%3A%2F%2Fx.com%2Ff%3Fa%3D1%26b%3D2')

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  process.exit(fail === 0 ? 0 : 1)
}

main()
