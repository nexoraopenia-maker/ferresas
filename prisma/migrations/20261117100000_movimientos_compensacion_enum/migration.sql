-- F6.3b · (1/2) Nueva categoría de movimiento de caja: la compensación de un abono de un turno ya cerrado.
-- Va SOLA en su migración: Postgres no deja usar un valor de enum recién creado dentro de la misma transacción; los CHECK que lo usan están en la siguiente.
ALTER TYPE "CashMovementCategory" ADD VALUE 'COMPENSACION_ABONO';
