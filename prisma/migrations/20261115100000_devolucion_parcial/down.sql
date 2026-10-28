-- Deshace 20261115100000_devolucion_parcial. SE PIERDEN los topes por línea, el destino de lo devuelto y las líneas de las notas de crédito parciales
-- (las devoluciones parciales hechas desde entonces quedan sin detalle de líneas; las ventas conservan su estado).
ALTER TABLE "tax_document_items" DROP CONSTRAINT IF EXISTS "tax_document_items_importes_chk";
ALTER TABLE "sale_return_items" DROP CONSTRAINT IF EXISTS "sale_return_items_merma_chk", DROP CONSTRAINT IF EXISTS "sale_return_items_importes_f62_chk";
ALTER TABLE "sale_returns" DROP CONSTRAINT IF EXISTS "sale_returns_total_chk";
ALTER TABLE "sale_items" DROP CONSTRAINT IF EXISTS "sale_items_devuelto_chk";
DROP TABLE IF EXISTS "tax_document_items";
DROP INDEX IF EXISTS "sale_return_items_tenantId_mermaId_idx";
ALTER TABLE "sale_return_items" DROP CONSTRAINT IF EXISTS "sale_return_items_tenantId_mermaId_fkey";
ALTER TABLE "sale_return_items" DROP COLUMN IF EXISTS "destination", DROP COLUMN IF EXISTS "mermaId", DROP COLUMN IF EXISTS "subtotal", DROP COLUMN IF EXISTS "taxAmount", DROP COLUMN IF EXISTS "taxRate";
ALTER TABLE "sale_returns" DROP COLUMN IF EXISTS "returnTotal";
ALTER TABLE "sale_items" DROP COLUMN IF EXISTS "returnedAmount", DROP COLUMN IF EXISTS "returnedQuantity";
DROP TYPE IF EXISTS "ReturnDestination";
