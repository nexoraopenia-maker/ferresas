-- Deshace 20261117100000_movimientos_compensacion_enum. Postgres no permite quitar un valor de un enum: se recrea el tipo SIN él.
-- Falla (y no borra nada) si todavía hay movimientos de esa categoría: hay que deshacer antes 20261117110000_movimientos_compensacion.
ALTER TABLE "cash_movements" DROP CONSTRAINT IF EXISTS "cash_movements_categoria_chk";
ALTER TYPE "CashMovementCategory" RENAME TO "CashMovementCategory_old";
CREATE TYPE "CashMovementCategory" AS ENUM ('GASTO_MENOR', 'RETIRO_DUENO', 'REPOSICION_FONDO', 'CORRECCION_ARQUEO', 'OTRO');
ALTER TABLE "cash_movements" ALTER COLUMN "category" TYPE "CashMovementCategory" USING ("category"::text::"CashMovementCategory");
DROP TYPE "CashMovementCategory_old";
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_categoria_chk" CHECK (
        ("kind" = 'INGRESO' AND "category" IN ('REPOSICION_FONDO', 'CORRECCION_ARQUEO', 'OTRO'))
     OR ("kind" = 'EGRESO'  AND "category" IN ('GASTO_MENOR', 'RETIRO_DUENO', 'CORRECCION_ARQUEO', 'OTRO'))
);
