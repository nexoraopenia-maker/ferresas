#!/usr/bin/env bash
#
# Aplica TODAS las migraciones pendientes a STAGING, en orden, y comprueba que no queda deriva.
#
#   bash scripts/migrar-staging.sh            # aplica
#   bash scripts/migrar-staging.sh --solo-ver # solo muestra el estado, no aplica nada
#
# Barreras (no se ejecuta nada si alguna falla):
#   · .env.local debe existir: ahí vive staging (`.env` es producción).
#   · host Y nombre de base de DATABASE_URL/DIRECT_URL no pueden coincidir con la huella de producción
#     (PROD_DB_FINGERPRINT, obligatoria, o la de .env). Sin esa variable tampoco se ejecuta.
#   · Se imprime el host y hay que escribir «staging» para continuar.
#
# Producción NO se migra con esto: el build de Vercel ejecuta `prisma migrate deploy` al desplegar.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env.local ] || { echo "✗ Falta .env.local (staging). No se hace nada."; exit 2; }

# Compara host Y nombre de base (sin -pooler ni credenciales) con la huella de producción
# (PROD_DB_FINGERPRINT o lo que diga .env). Imprime solo huellas. Sale con 2 si hay coincidencia
# o si falta la huella explícita.
if ! npx tsx scripts/huella-bd.ts; then
  echo "✗ Abortado: no se puede garantizar que el destino NO sea producción. No se ejecutó nada."
  exit 2
fi
H_STAGING="$(npx tsx scripts/huella-bd.ts | sed -n 's/^DATABASE_URL: //p')"
H_PROD="(ver PROD_DB_FINGERPRINT)"
echo "Destino (host/base): $H_STAGING"
echo "Producción: no se toca"
echo
echo "== 1) Estado de las migraciones"
npx prisma migrate status || true

if [ "${1:-}" = "--solo-ver" ]; then echo; echo "(solo lectura: no se aplicó nada)"; exit 0; fi

read -r -p "¿Aplicar las pendientes a $H_STAGING? Escribe «staging»: " R
[ "$R" = "staging" ] || { echo "Cancelado."; exit 1; }

echo; echo "== 2) Aplicar (prisma migrate deploy: en orden, solo las pendientes)"
npx prisma migrate deploy

echo; echo "== 3) Regenerar el cliente"
npx prisma generate

echo; echo "== 4) Comprobar que la base coincide con prisma/schema.prisma (sin deriva)"
if npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code; then
  echo "✓ Sin deriva: staging coincide con el esquema."
else
  echo "✗ HAY DERIVA entre staging y el esquema. Revisar antes de seguir."; exit 3
fi
