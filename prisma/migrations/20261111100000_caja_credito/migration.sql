-- AlterTable
ALTER TABLE "cash_sessions" ADD COLUMN     "cashReceiptsTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "creditSalesTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "otherReceiptsTotal" DECIMAL(14,2) NOT NULL DEFAULT 0;


-- Totales de crédito del turno: nunca negativos (se congelan al cerrar; un turno abierto los tiene en 0).
ALTER TABLE "cash_sessions"
  ADD CONSTRAINT "cash_sessions_credito_chk" CHECK ("creditSalesTotal" >= 0 AND "cashReceiptsTotal" >= 0 AND "otherReceiptsTotal" >= 0);
