-- Deshace 20261116100000_movimientos_caja. SE PIERDEN los movimientos manuales de caja registrados desde entonces; el efectivo esperado
-- congelado de los turnos cerrados que los incluían conserva su valor, pero ya no habrá detalle de qué ingresos y egresos lo componían.
ALTER TABLE "cash_sessions" DROP CONSTRAINT IF EXISTS "cash_sessions_manuales_chk";
DROP TABLE IF EXISTS "cash_movements";
ALTER TABLE "cash_sessions" DROP COLUMN IF EXISTS "manualInTotal", DROP COLUMN IF EXISTS "manualOutTotal";
DROP TYPE IF EXISTS "CashMovementCategory";
DROP TYPE IF EXISTS "CashMovementKind";
