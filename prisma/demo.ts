import { config } from 'dotenv'
config({ path: '.env.local' })
config({ path: '.env' })
import { assertWritableEnvironment } from '../src/lib/env-guard'
import { asegurarDatosDemo, correoDemo, prepararCuentaDemo } from '../src/features/demo/seed'

/**
 * npm run demo:crear
 *
 * Crea (o reconoce) la cuenta de demostración y precarga sus datos. Es
 * IDEMPOTENTE: se puede lanzar las veces que haga falta.
 *
 *   DEMO_EMAIL     correo de la demo (por defecto pool@fer.pe)
 *   DEMO_PASSWORD  solo hace falta la primera vez, para crear el usuario.
 *                  Va en .env.local / el entorno; nunca en el código.
 *
 * Se niega a tocar un correo que ya sea de un negocio real.
 */
assertWritableEnvironment({
  script: 'prisma/demo.ts',
  efecto: 'crea la cuenta demo (negocio ficticio) y le precarga productos, clientes, cotizaciones y ventas',
})

async function main() {
  const email = correoDemo()
  console.log(`Cuenta demo: ${email}`)
  const c = await prepararCuentaDemo({ email, password: process.env.DEMO_PASSWORD })
  console.log(c.creada ? '  · usuario y negocio creados' : '  · ya existía')
  const t0 = Date.now()
  const r = await asegurarDatosDemo(c.tenantId)
  const s = Math.round((Date.now() - t0) / 1000)
  console.log(
    r === 'sembrada' ? `  · datos de demostración precargados (${s} s)` : '  · los datos ya estaban completos (nada que hacer)',
  )
}

main().then(() => process.exit(0), (e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
