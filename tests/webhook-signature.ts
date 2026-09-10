import {
  verifyStripeSignature, verifyMercadoPagoSignature,
  signStripePayload, signMercadoPagoManifest,
} from '@/features/billing/webhook-verify'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}

const SECRET = 'whsec_muy_secreto'
const body = JSON.stringify({ id: 'evt_1', type: 'invoice.payment_succeeded' })
const now = new Date('2026-08-24T12:00:00Z')
const ts = Math.floor(now.getTime() / 1000)

console.log('\n1) Stripe — firma válida')
{
  const header = signStripePayload(SECRET, body, ts)
  check('acepta una firma correcta',
    verifyStripeSignature({ rawBody: body, signatureHeader: header, secret: SECRET, now }).ok)
}

console.log('\n2) Stripe — ataques')
{
  const header = signStripePayload(SECRET, body, ts)
  const manipulado = JSON.stringify({ id: 'evt_1', type: 'customer.subscription.deleted' })
  const r = verifyStripeSignature({ rawBody: manipulado, signatureHeader: header, secret: SECRET, now })
  check('rechaza si el CUERPO fue manipulado', !r.ok && r.reason === 'BAD_SIGNATURE')
}
{
  const falsa = signStripePayload('secreto-del-atacante', body, ts)
  const r = verifyStripeSignature({ rawBody: body, signatureHeader: falsa, secret: SECRET, now })
  check('rechaza una firma hecha con otro secreto', !r.ok && r.reason === 'BAD_SIGNATURE')
}
{
  // Evento legítimo capturado de la red y reenviado 10 minutos después.
  const viejo = signStripePayload(SECRET, body, ts - 600)
  const r = verifyStripeSignature({ rawBody: body, signatureHeader: viejo, secret: SECRET, now })
  check('rechaza un REPLAY fuera de la ventana', !r.ok && r.reason === 'TIMESTAMP_OUT_OF_TOLERANCE')
}
{
  const casi = signStripePayload(SECRET, body, ts - 200)
  check('acepta dentro de la ventana de 5 min (reloj desfasado)',
    verifyStripeSignature({ rawBody: body, signatureHeader: casi, secret: SECRET, now }).ok)
}
{
  const r = verifyStripeSignature({ rawBody: body, signatureHeader: null, secret: SECRET, now })
  check('rechaza sin cabecera', !r.ok && r.reason === 'MISSING_HEADER')
}
{
  const r = verifyStripeSignature({ rawBody: body, signatureHeader: 'basura', secret: SECRET, now })
  check('rechaza cabecera malformada', !r.ok && r.reason === 'MALFORMED_HEADER')
}
{
  const r = verifyStripeSignature({ rawBody: body, signatureHeader: signStripePayload(SECRET, body, ts), secret: undefined, now })
  check('rechaza si NO hay secreto configurado (no abre la puerta)',
    !r.ok && r.reason === 'MISSING_SECRET')
}
{
  // v0 es el esquema antiguo; aceptarlo sería una vía de degradación.
  const solo0 = `t=${ts},v0=deadbeef`
  const r = verifyStripeSignature({ rawBody: body, signatureHeader: solo0, secret: SECRET, now })
  check('ignora firmas v0 y solo confía en v1', !r.ok && r.reason === 'MALFORMED_HEADER')
}
{
  // Stripe rota secretos enviando varias v1; basta con que una coincida.
  const buena = signStripePayload(SECRET, body, ts).split('v1=')[1]
  const multi = `t=${ts},v1=0000000000000000000000000000000000000000000000000000000000000000,v1=${buena}`
  check('acepta si una de varias firmas v1 coincide (rotación de secreto)',
    verifyStripeSignature({ rawBody: body, signatureHeader: multi, secret: SECRET, now }).ok)
}

console.log('\n3) MercadoPago')
{
  const header = signMercadoPagoManifest('mp_secreto', '12345', 'req-abc', ts)
  check('acepta manifiesto correcto',
    verifyMercadoPagoSignature({
      signatureHeader: header, requestId: 'req-abc', dataId: '12345',
      secret: 'mp_secreto', now,
    }).ok)
  const r = verifyMercadoPagoSignature({
    signatureHeader: header, requestId: 'req-DISTINTO', dataId: '12345',
    secret: 'mp_secreto', now,
  })
  check('rechaza si cambia el request-id', !r.ok && r.reason === 'BAD_SIGNATURE')
  const r2 = verifyMercadoPagoSignature({
    signatureHeader: header, requestId: 'req-abc', dataId: '99999',
    secret: 'mp_secreto', now,
  })
  check('rechaza si cambia el data.id', !r2.ok && r2.reason === 'BAD_SIGNATURE')
}
{
  const header = signMercadoPagoManifest('mp_secreto', 'AbC123', 'req-1', ts)
  check('normaliza el id alfanumérico a minúsculas, como documenta MP',
    verifyMercadoPagoSignature({
      signatureHeader: header, requestId: 'req-1', dataId: 'AbC123',
      secret: 'mp_secreto', now,
    }).ok)
}
{
  // MP manda el ts en ms en algunos avisos.
  const tsMs = ts * 1000
  const header = signMercadoPagoManifest('mp_secreto', '77', 'req-2', tsMs)
  check('tolera timestamp en milisegundos',
    verifyMercadoPagoSignature({
      signatureHeader: header, requestId: 'req-2', dataId: '77',
      secret: 'mp_secreto', now,
    }).ok)
}

console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
process.exit(fail === 0 ? 0 : 1)
