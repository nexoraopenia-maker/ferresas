-- Deshace 20261113100000_compras_documento. Solo se pierden los datos de documento que se hayan capturado desde entonces
-- (tipo, serie, número y fecha de emisión); `invoiceRef` sigue guardando «SERIE-NÚMERO», así que la referencia no se pierde.
ALTER TABLE "purchases" DROP CONSTRAINT IF EXISTS "purchases_documento_formato_chk";
ALTER TABLE "purchases" DROP CONSTRAINT IF EXISTS "purchases_documento_completo_chk";
DROP INDEX IF EXISTS "purchases_tenantId_issueDate_idx";
ALTER TABLE "purchases" DROP COLUMN IF EXISTS "docNumber", DROP COLUMN IF EXISTS "docSeries", DROP COLUMN IF EXISTS "docType", DROP COLUMN IF EXISTS "issueDate";
DROP TYPE IF EXISTS "PurchaseDocType";
