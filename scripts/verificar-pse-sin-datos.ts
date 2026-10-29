/**
 * SOLO LECTURA. Antes de aplicar la migración `retirar_pse` (S6, DESTRUCTIVA): cuenta cuántos negocios tienen todavía datos en las columnas que se van a eliminar
 * (`tenants.pseEndpointUrl`, `pseTokenEnc`, `pseConfiguredAt`). No modifica nada y no imprime ningún valor (el token está cifrado y es secreto), solo cuántos hay.
 *
 *   npx tsx scripts/verificar-pse-sin-datos.ts
 *
 * Código de salida: 0 = ninguna fila con datos (o las columnas ya no existen: se puede desplegar) · 3 = hay filas con datos (se PERDERÍAN: revisa antes) · 1 = falló.
 */
import { config } from 'dotenv'
config({ path: '.env.local' })
config({ path: '.env' })

import { prisma } from '../src/lib/prisma'

async function main() {
  const cols = await prisma.$queryRaw<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
     WHERE table_name = 'tenants' AND column_name IN ('pseEndpointUrl', 'pseTokenEnc', 'pseConfiguredAt')`
  if (cols.length === 0) {
    console.log('SOLO LECTURA (no se escribió nada): las columnas del PSE ya no existen en esta base. Nada que perder.')
    return
  }
  const [r] = await prisma.$queryRaw<{ url: bigint; token: bigint; config: bigint }[]>`
    SELECT count("pseEndpointUrl") AS url, count("pseTokenEnc") AS token, count("pseConfiguredAt") AS config FROM tenants`
  const url = Number(r!.url), token = Number(r!.token), conf = Number(r!.config)
  if (url + token + conf === 0) {
    console.log('SOLO LECTURA (no se escribió nada): ningún negocio tiene datos del PSE. La migración que elimina las columnas no pierde nada.')
    return
  }
  console.log(`SOLO LECTURA (no se escribió nada): HAY datos del PSE que la migración eliminaría — ${url} URL(s), ${token} token(s) cifrado(s), ${conf} fecha(s) de configuración. Revísalos antes de desplegar.`)
  process.exitCode = 3
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) }).finally(() => prisma.$disconnect())
