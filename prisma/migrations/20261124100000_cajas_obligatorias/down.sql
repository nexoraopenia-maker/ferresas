-- Reversa de F6.8d (volver al estado del paso 1). `cashRequired` se recrea APAGADO: su valor anterior no se puede reconstruir y ya no tenía efecto.
ALTER TABLE "tenants" ADD COLUMN "cashRequired" BOOLEAN NOT NULL DEFAULT false;

DROP INDEX "cash_sessions_una_abierta_por_caja";
ALTER TABLE "cash_sessions" ALTER COLUMN "registerId" DROP NOT NULL;
CREATE UNIQUE INDEX "cash_sessions_una_abierta_por_caja" ON "cash_sessions" ("tenantId", "registerId") WHERE "status" = 'ABIERTA' AND "registerId" IS NOT NULL;
CREATE UNIQUE INDEX "cash_sessions_una_abierta_sin_caja" ON "cash_sessions" ("tenantId", "branchId") WHERE "status" = 'ABIERTA' AND "registerId" IS NULL;
