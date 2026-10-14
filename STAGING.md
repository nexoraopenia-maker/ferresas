# Entorno de staging

Una base de datos desechable para que los tests y los experimentos no toquen
producción.

## Por qué hace falta

`npm test` crea y borra tenants, usuarios, productos, ventas y comprobantes.
Escribe en la base a la que apunte el entorno. Dos veces ya la suite dejó
once tenants de prueba en la base de producción, junto al cliente real, y
hubo que limpiarlos a mano.

Desde ahora la suite **se niega a arrancar** si el entorno no declara
`ALLOW_DESTRUCTIVE_TESTS=true`. Producción nunca llevará esa variable, así
que olvidarse ya no destruye nada.

---

## 1. Crear la base en Neon

En el panel de Neon, dentro del **mismo proyecto**:

1. **Branches** → **New branch**
2. Nómbrala `staging`, partiendo de `main`
3. **Connection details** y copia las dos URLs:
   - **Pooled connection** → para `DATABASE_URL`
   - **Direct connection** (sin `-pooler` en el host) → para `DIRECT_URL`

Una rama de Neon es copy-on-write: se crea en segundos, arranca con los datos
actuales y no duplica el coste de almacenamiento. Es preferible a un proyecto
aparte precisamente porque parte del esquema real, así que una migración que
funcione aquí funcionará en producción.

> Si prefieres una base vacía, crea un **proyecto** nuevo en lugar de una
> rama. El resto de los pasos es idéntico.

---

## 2. Crear `.env.local`

Next.js y los tests cargan `.env.local` **con prioridad sobre `.env`**. Así
`.env` queda apuntando a producción y `.env.local` a staging, sin tener que
editar nada antes de cada ejecución.

```bash
cat > .env.local <<'EOF'
# ───────── STAGING ─────────
# Tiene prioridad sobre .env. No se sube al repositorio.

DATABASE_URL="postgresql://USUARIO:CLAVE@ep-XXXX-pooler.REGION.aws.neon.tech/neondb?sslmode=require&pgbouncer=true&connection_limit=1"
DIRECT_URL="postgresql://USUARIO:CLAVE@ep-XXXX.REGION.aws.neon.tech/neondb?sslmode=require"

# Lo que habilita la suite. NUNCA pongas esto en producción.
ALLOW_DESTRUCTIVE_TESTS=true

# Secretos propios de staging: distintos a los de producción, para que una
# cookie de staging no valga en producción ni al revés.
AUTH_SECRET="GENERA_UNO_CON: npx auth secret"
CRON_SECRET="GENERA_UNO_CON: openssl rand -hex 32"

APP_URL="http://localhost:3000"

# Credenciales del superadmin de staging.
SUPERADMIN_EMAIL="admin@staging.local"
SUPERADMIN_PASSWORD="staging-no-importa-123"
EOF
```

`.gitignore` ya cubre `.env.*`, así que `.env.local` no se sube. Verifícalo:

```bash
git check-ignore .env.local   # debe imprimir: .env.local
```

---

## 3. Preparar el esquema y los datos

```bash
npx prisma migrate deploy     # aplica las migraciones a staging
npm run db:seed               # planes + superadmin de staging
```

`migrate deploy` solo aplica migraciones ya existentes: no genera ninguna ni
toca el esquema por su cuenta. Es la única forma permitida de mover el
esquema (ver más abajo).

---

## 4. Comprobar que apuntas a staging

```bash
npm test
```

La primera línea de la suite dice el destino:

```
▸ suite habilitada contra ep-XXXX-pooler.REGION.aws.neon.tech/neondb
```

Si ves el host de producción ahí, **detente**: `.env.local` no se está
cargando o lleva la URL equivocada.

Y para ver el estado completo de cualquier entorno:

```bash
npm run dev
# luego: http://localhost:3000/api/diagnostics?key=$CRON_SECRET
```

---

## 5. Migraciones: el procedimiento permitido

**Prohibido `prisma db push`.** Reescribe el esquema sin dejar historial y
puede borrar columnas con datos. No existe ningún script que lo invoque y no
debe añadirse.

El flujo es siempre:

```bash
# 1. Cambias prisma/schema.prisma

# 2. Generas la migración CONTRA STAGING, sin aplicarla
npx prisma migrate dev --create-only --name descripcion_corta

# 3. LEES el SQL generado en prisma/migrations/<fecha>_descripcion/
#    Buscas DROP COLUMN, DROP TABLE, ALTER ... TYPE y cualquier NOT NULL
#    sin DEFAULT sobre una tabla con filas. Si aparece algo de eso, se
#    reescribe a mano en dos pasos (añadir, copiar, luego retirar).

# 4. Aplicas en staging y pruebas
npx prisma migrate deploy
npm test

# 5. Commit. En producción la aplica el build de Vercel:
#    build = if [ "$VERCEL_ENV" = "production" ]; then prisma migrate deploy; fi && next build
```

El paso 3 es el que importa. `migrate dev` genera SQL destructivo sin
preguntar cuando detecta que una columna sobra, y en producción eso no se
deshace.

---

## 6. Vercel

Opcionalmente, apunta los **deploys de preview** a staging:

Settings → Environment Variables → añade `DATABASE_URL` y `DIRECT_URL` con
los valores de staging y marca **solo** el entorno *Preview*. Producción
mantiene los suyos.

Con eso, una rama en revisión nunca escribe en la base de los clientes.

> El `build` solo ejecuta `migrate deploy` cuando `VERCEL_ENV=production`, así
> que un preview no migra ninguna base. Si quieres que los previews migren
> staging, hay que ampliar esa condición a propósito.
