/**
 * Carga de entorno: `.env.local` ANTES de `.env`.
 *
 * dotenv no sobrescribe lo ya definido, así que `.env.local` —donde vive
 * staging— gana sobre `.env` —producción—. Sin este orden, el CLI de Prisma
 * apuntaba siempre a producción aunque `.env.local` dijera otra cosa: eso ya
 * hizo que un `migrate deploy` y un `db seed` destinados a staging se
 * ejecutaran contra la base real.
 */
import { config } from 'dotenv'
config({ path: '.env.local' })
config({ path: '.env' })
import path from 'node:path'
import { defineConfig, env } from 'prisma/config'

/**
 * Configuración del CLI de Prisma (v7+).
 *
 * Desde la v7 el bloque `datasource` del schema ya no lleva `url`, y la clave
 * `directUrl` desapareció: el tipo `Datasource` de prisma/config solo acepta
 * `url` y `shadowDatabaseUrl`.
 *
 * Reparto de responsabilidades:
 *  - `datasource.url` de este archivo lo usan SOLO los comandos del CLI
 *    (migrate, db push, db pull, studio). Debe ser la conexión DIRECTA, sin
 *    pooler: Supabase/Neon no soportan sentencias DDL a través de PgBouncer
 *    en modo transaction. Por eso DIRECT_URL tiene prioridad.
 *  - `DATABASE_URL` (pooled) lo consume el runtime a través del driver
 *    adapter que se le pasa a `new PrismaClient({ adapter })`, no este config.
 *
 * En desarrollo local suele haber una sola URL: el fallback cubre ese caso.
 */
export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),

  datasource: {
    url: process.env.DIRECT_URL ? env('DIRECT_URL') : env('DATABASE_URL'),
    // Base efímera que Prisma usa para detectar drift al generar migraciones.
    // Opcional en local; recomendable en Supabase/Neon para no ensuciar la BD.
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL
      ? env('SHADOW_DATABASE_URL')
      : undefined,
  },

  migrations: {
    path: path.join('prisma', 'migrations'),
    seed: 'tsx prisma/seed.ts',
  },
})
