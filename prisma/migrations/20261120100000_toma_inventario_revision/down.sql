-- Deshace F6.5b (solo desarrollo y emergencias: borra lo que cada línea guardó de su revisión y aplicación; el stock y los movimientos no se tocan).
ALTER TABLE "inventory_count_items"
  DROP CONSTRAINT IF EXISTS "inventory_count_items_movidos_chk",
  DROP CONSTRAINT IF EXISTS "inventory_count_items_costo_chk",
  DROP CONSTRAINT IF EXISTS "inventory_count_items_movimiento_chk",
  DROP CONSTRAINT IF EXISTS "inventory_count_items_diferencia_chk",
  DROP CONSTRAINT IF EXISTS "inventory_count_items_aprobado_chk",
  DROP CONSTRAINT IF EXISTS "inventory_count_items_motivo_chk",
  DROP CONSTRAINT IF EXISTS "inventory_count_items_revision_chk";
ALTER TABLE "inventory_count_items"
  DROP CONSTRAINT IF EXISTS "inventory_count_items_reviewedById_fkey",
  DROP CONSTRAINT IF EXISTS "inventory_count_items_tenantId_resultingMovementId_fkey";
DROP INDEX IF EXISTS "stock_movements_tenantId_id_key";
ALTER TABLE "inventory_count_items"
  DROP COLUMN "thresholdConfirmed", DROP COLUMN "reviewNote", DROP COLUMN "reviewedById", DROP COLUMN "reviewedAt", DROP COLUMN "resultingMovementId",
  DROP COLUMN "costAtApply", DROP COLUMN "movedSinceCount", DROP COLUMN "difference", DROP COLUMN "systemQtyAtCount";
