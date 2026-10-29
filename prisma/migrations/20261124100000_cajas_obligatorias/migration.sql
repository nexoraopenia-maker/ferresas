-- F6.8d · Varias cajas por sucursal — PASO 2 de 2 (contraer).
--
-- Todo turno nace ya en una caja (desde F6.8b) y el relleno del paso 1 dejó los antiguos en la «Caja principal»: `registerId` pasa a ser OBLIGATORIO, se retira el índice de transición de los turnos
-- SIN caja y se elimina el ajuste `cashRequired` (el turno propio es obligatorio SIEMPRE, no un interruptor del negocio).
--
-- ⚠️ ANTES DE APLICAR EN UN ENTORNO: correr `scripts/verificar-turnos-sin-caja.ts` (debe dar cero). Por si aun así quedara algún turno sin caja, el relleno de abajo (el mismo del paso 1, idempotente) lo manda a la caja
-- viva más antigua de su sucursal ANTES de exigir NOT NULL: así esta migración no puede dejar la base marcada como fallida (P3009) por ese motivo.
-- `cashRequired` se pierde: el SQL de reversa lo recrea apagado (su valor no se puede reconstruir, y ya no tenía efecto).

-- BACKFILL INICIO (idempotente)
INSERT INTO "cash_registers" ("id", "tenantId", "branchId", "name", "isActive", "createdAt", "updatedAt")
SELECT 'caja_' || md5(b."tenantId" || ':' || b."id" || ':principal'), b."tenantId", b."id", 'Caja principal', true, now(), now()
FROM "branches" b
WHERE NOT EXISTS (SELECT 1 FROM "cash_registers" r WHERE r."tenantId" = b."tenantId" AND r."branchId" = b."id");

UPDATE "cash_sessions" s
SET "registerId" = (
  SELECT r."id" FROM "cash_registers" r
  WHERE r."tenantId" = s."tenantId" AND r."branchId" = s."branchId" AND r."deletedAt" IS NULL
  ORDER BY r."createdAt", r."id" LIMIT 1
)
WHERE s."registerId" IS NULL;
-- BACKFILL FIN

-- Índices parciales: el de los turnos sin caja ya no tiene filas a las que aplicarse; el de «uno por caja» pierde la condición `IS NOT NULL`, que ya no puede ser falsa.
DROP INDEX "cash_sessions_una_abierta_sin_caja";
DROP INDEX "cash_sessions_una_abierta_por_caja";

-- AlterTable
ALTER TABLE "cash_sessions" ALTER COLUMN "registerId" SET NOT NULL;

CREATE UNIQUE INDEX "cash_sessions_una_abierta_por_caja" ON "cash_sessions" ("tenantId", "registerId") WHERE "status" = 'ABIERTA';

-- AlterTable
ALTER TABLE "tenants" DROP COLUMN "cashRequired";
