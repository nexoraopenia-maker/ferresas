/**
 * Re-cifra los secretos guardados (certificado y claves de SUNAT, token del PSE, secretos de MFA) con la clave maestra ACTUAL. Para rotar la clave:
 *
 *   1) agrega la clave nueva a SECRETOS_CLAVES y declárala en SECRETOS_CLAVE_ACTUAL (deja la vieja en el JSON);
 *   2) npx tsx scripts/recifrar-secretos.ts            → SOLO MIRA: cuántos hay por re-cifrar y cuáles no se pueden leer;
 *   3) npx tsx scripts/recifrar-secretos.ts --aplicar  → re-cifra (de a uno, comprobando que lo escrito se lee);
 *   4) repite el paso 2 hasta ver «0 por re-cifrar»; recién entonces quita la clave vieja del entorno.
 *
 * Un valor ilegible se reporta y NO se toca. Nunca imprime un secreto. Código de salida: 0 todo bien · 3 quedaron ilegibles · 1 fallo.
 */
import { config } from 'dotenv'
config({ path: '.env.local' })
config({ path: '.env' })

import { prisma } from '../src/lib/prisma'
import { hayClaveMaestra } from '../src/lib/cifrado'
import { recifrarSecretos } from '../src/features/seguridad/recifrado'

async function main() {
  if (!hayClaveMaestra()) { console.error('No hay clave maestra actual configurada (SECRETOS_CLAVES / SECRETOS_CLAVE_ACTUAL o PSE_MASTER_KEY). No se hace nada.'); process.exit(1) }
  const aplicar = process.argv.includes('--aplicar')
  const r = await recifrarSecretos(prisma as never, { aplicar })
  console.log(`${aplicar ? 'APLICADO' : 'SOLO LECTURA (no se escribió nada)'}: ${r.revisados} secreto(s) revisados · ${r.yaVigentes} ya con la clave actual · ${r.recifrados} ${aplicar ? 're-cifrados' : 'por re-cifrar'} · ${r.ilegibles.length} ilegibles.`)
  for (const i of r.ilegibles.slice(0, 50)) console.log(`  ✗ ${i.tabla}.${i.campo} (${i.id}): no se puede leer con las claves configuradas; no se tocó.`)
  if (r.ilegibles.length > 0) process.exitCode = 3
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) }).finally(() => prisma.$disconnect())
