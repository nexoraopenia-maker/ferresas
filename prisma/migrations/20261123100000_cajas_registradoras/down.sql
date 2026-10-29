-- Deshace F6.8a (solo desarrollo y emergencias): BORRA las cajas y la foto del desglose de los cierres, y deja los turnos otra vez «uno abierto por sucursal».
-- ⚠️ Falla si hay dos turnos abiertos en la misma sucursal (porque ya hay varias cajas abiertas): ciérralos antes.
DROP INDEX IF EXISTS "cash_registers_name_uniq";
DROP INDEX IF EXISTS "cash_sessions_una_abierta_sin_caja";
DROP INDEX IF EXISTS "cash_sessions_una_abierta_por_persona";
DROP INDEX IF EXISTS "cash_sessions_una_abierta_por_caja";
ALTER TABLE "cash_sessions" DROP CONSTRAINT IF EXISTS "cash_sessions_desglose_chk";
ALTER TABLE "cash_sessions" DROP CONSTRAINT IF EXISTS "cash_sessions_tenantId_registerId_fkey";
DROP INDEX IF EXISTS "cash_sessions_tenantId_registerId_idx";
ALTER TABLE "cash_sessions" DROP COLUMN IF EXISTS "closingBreakdown";
ALTER TABLE "cash_sessions" DROP COLUMN IF EXISTS "registerId";
DROP TABLE IF EXISTS "cash_registers";
CREATE UNIQUE INDEX "cash_sessions_una_abierta_por_sucursal" ON "cash_sessions" ("tenantId", "branchId") WHERE "status" = 'ABIERTA';
