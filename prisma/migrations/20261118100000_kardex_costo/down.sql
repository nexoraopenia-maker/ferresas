-- Deshace F6.4a (solo desarrollo y emergencias: borra el costo guardado en los movimientos; el stock y los movimientos no se tocan).
ALTER TABLE "stock_movements"
  DROP CONSTRAINT IF EXISTS "stock_movements_costo_origen_chk",
  DROP CONSTRAINT IF EXISTS "stock_movements_costo_chk";
ALTER TABLE "stock_movements" DROP COLUMN "unitCostApplied", DROP COLUMN "costAfter", DROP COLUMN "costOrigin";
DROP TYPE "MovementCostOrigin";
