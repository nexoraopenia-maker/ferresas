-- Deshace 20261114100000_devoluciones_venta. SE PIERDE el registro de devoluciones y reembolsos hecho desde entonces
-- (las ventas conservan su estado ANULADA/DEVUELTA, pero ya no hay detalle ni vínculo con la nota de crédito).
ALTER TABLE "sales" DROP CONSTRAINT IF EXISTS "sales_anulada_devuelta_chk";
ALTER TABLE "cash_sessions" DROP CONSTRAINT IF EXISTS "cash_sessions_reembolsos_chk";
DROP TABLE IF EXISTS "sale_return_refunds";
DROP TABLE IF EXISTS "sale_return_items";
DROP TABLE IF EXISTS "sale_returns";
ALTER TABLE "cash_sessions" DROP COLUMN IF EXISTS "refundsCashTotal", DROP COLUMN IF EXISTS "refundsOtherTotal";
DROP INDEX IF EXISTS "sale_items_tenantId_id_key";
DROP TYPE IF EXISTS "RefundMode";
DROP TYPE IF EXISTS "SaleReturnKind";
