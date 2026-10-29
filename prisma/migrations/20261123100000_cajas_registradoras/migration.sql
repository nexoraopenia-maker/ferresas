-- F6.8a · Varias cajas por sucursal — PASO 1 de 2 (expandir; aditiva).
--
-- Crea `cash_registers` (la caja: un puesto de cobro de una sucursal) y añade a `cash_sessions` la columna `registerId` (NULA por ahora) y `closingBreakdown` (la foto del desglose del cierre).
-- Después RELLENA: una «Caja principal» por cada sucursal existente y todos sus turnos —cerrados y ABIERTOS— quedan en ella, así que el turno que esté abierto al desplegar sigue operando.
-- El paso 2 (F6.8d, un despliegue aparte) vuelve `registerId` NOT NULL cuando `scripts/verificar-turnos-sin-caja.ts` dé cero.
--
-- ⚠️ ANTES DE APLICAR EN UN ENTORNO: correr `scripts/verificar-turnos-abiertos.ts`. El índice «un turno abierto por persona» FALLA si alguien tiene hoy dos turnos abiertos (p. ej. un usuario
-- asignado a dos sucursales que abrió caja en ambas). Una migración fallida deja la base marcada como fallida (P3009).
--
-- Los índices únicos de los turnos abiertos son PARCIALES (Prisma no los expresa). El índice viejo «una abierta por sucursal» se retira porque impediría la segunda caja; lo reemplazan tres:
-- por caja, por persona y —solo para los turnos SIN caja, que puede abrir la versión anterior del código durante la ventana de despliegue— uno por sucursal, que conserva la protección de siempre.
-- Los CHECK usan `IS NOT NULL` explícito donde una columna puede ser nula: un CHECK cuyo resultado es NULL APRUEBA.


-- AlterTable
ALTER TABLE "cash_sessions" ADD COLUMN     "closingBreakdown" JSONB,
ADD COLUMN     "registerId" TEXT;

-- CreateTable
CREATE TABLE "cash_registers" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "cash_registers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cash_registers_tenantId_branchId_idx" ON "cash_registers"("tenantId", "branchId");

-- CreateIndex
CREATE UNIQUE INDEX "cash_registers_tenantId_id_key" ON "cash_registers"("tenantId", "id");

-- CreateIndex
CREATE INDEX "cash_sessions_tenantId_registerId_idx" ON "cash_sessions"("tenantId", "registerId");

-- AddForeignKey
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_tenantId_registerId_fkey" FOREIGN KEY ("tenantId", "registerId") REFERENCES "cash_registers"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "cash_registers" ADD CONSTRAINT "cash_registers_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_registers" ADD CONSTRAINT "cash_registers_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "branches"("tenantId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- CheckConstraints
ALTER TABLE "cash_registers"
  ADD CONSTRAINT "cash_registers_nombre_chk" CHECK (length(btrim("name")) BETWEEN 2 AND 30);
-- La foto del desglose solo existe en turnos CERRADOS.
ALTER TABLE "cash_sessions"
  ADD CONSTRAINT "cash_sessions_desglose_chk" CHECK ("closingBreakdown" IS NULL OR "status" = 'CERRADA');

-- BACKFILL INICIO (idempotente: se puede correr otra vez sin duplicar nada)
-- Una «Caja principal» por cada sucursal que aún no tenga ninguna caja. El id es determinista (md5 de la sucursal), así que reintentar no crea otra.
INSERT INTO "cash_registers" ("id", "tenantId", "branchId", "name", "isActive", "createdAt", "updatedAt")
SELECT 'caja_' || md5(b."tenantId" || ':' || b."id" || ':principal'), b."tenantId", b."id", 'Caja principal', true, now(), now()
FROM "branches" b
WHERE NOT EXISTS (SELECT 1 FROM "cash_registers" r WHERE r."tenantId" = b."tenantId" AND r."branchId" = b."id");

-- Todos los turnos sin caja (cerrados y abiertos) pasan a la caja viva más antigua de su sucursal. No se toca `updatedAt`: un turno cerrado no debe parecer modificado.
UPDATE "cash_sessions" s
SET "registerId" = (
  SELECT r."id" FROM "cash_registers" r
  WHERE r."tenantId" = s."tenantId" AND r."branchId" = s."branchId" AND r."deletedAt" IS NULL
  ORDER BY r."createdAt", r."id" LIMIT 1
)
WHERE s."registerId" IS NULL;
-- BACKFILL FIN

-- Índices únicos parciales de los turnos abiertos (se crean DESPUÉS del relleno).
DROP INDEX "cash_sessions_una_abierta_por_sucursal";
CREATE UNIQUE INDEX "cash_sessions_una_abierta_por_caja" ON "cash_sessions" ("tenantId", "registerId") WHERE "status" = 'ABIERTA' AND "registerId" IS NOT NULL;
CREATE UNIQUE INDEX "cash_sessions_una_abierta_por_persona" ON "cash_sessions" ("tenantId", "openedById") WHERE "status" = 'ABIERTA';
CREATE UNIQUE INDEX "cash_sessions_una_abierta_sin_caja" ON "cash_sessions" ("tenantId", "branchId") WHERE "status" = 'ABIERTA' AND "registerId" IS NULL;

-- El nombre de una caja es único (sin distinguir mayúsculas) entre las NO borradas de su sucursal.
CREATE UNIQUE INDEX "cash_registers_name_uniq" ON "cash_registers" ("tenantId", "branchId", lower("name")) WHERE "deletedAt" IS NULL;
