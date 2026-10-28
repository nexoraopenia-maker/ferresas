-- Deshace 20261117110000_movimientos_compensacion. SE PIERDEN las compensaciones de abonos registradas desde entonces (el abono anulado conserva su
-- anulación, pero ya no habrá el egreso que la compensó en la caja). Se borran antes de quitar las reglas que las permitían.
DROP INDEX IF EXISTS "cash_movements_una_compensacion_por_abono";
DELETE FROM "cash_movements" WHERE "category" = 'COMPENSACION_ABONO';
ALTER TABLE "cash_movements" DROP CONSTRAINT IF EXISTS "cash_movements_medio_chk", DROP CONSTRAINT IF EXISTS "cash_movements_compensacion_chk", DROP CONSTRAINT IF EXISTS "cash_movements_categoria_chk";
ALTER TABLE "cash_movements" DROP COLUMN IF EXISTS "method";
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_categoria_chk" CHECK (
        ("kind" = 'INGRESO' AND "category" IN ('REPOSICION_FONDO', 'CORRECCION_ARQUEO', 'OTRO'))
     OR ("kind" = 'EGRESO'  AND "category" IN ('GASTO_MENOR', 'RETIRO_DUENO', 'CORRECCION_ARQUEO', 'OTRO'))
);
