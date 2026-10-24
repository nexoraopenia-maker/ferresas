-- Reversa de init_notas_credito_debito. DESTRUCTIVA si ya se emitieron notas: se niega a borrarlas.
-- (Los valores añadidos a un enum de Postgres no se pueden quitar: NOTA_CREDITO y NOTA_DEBITO quedan en el tipo, sin uso.)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "tax_documents" WHERE "relatedDocumentId" IS NOT NULL) THEN
    RAISE EXCEPTION 'Hay notas de crédito/débito emitidas: no se puede volver al esquema de un comprobante por venta.';
  END IF;
END $$;

ALTER TABLE "tax_documents" DROP CONSTRAINT "tax_documents_nota_campos_chk";
DROP INDEX "tax_documents_un_comprobante_por_venta";
ALTER TABLE "tax_documents" DROP CONSTRAINT "tax_documents_tenantId_relatedDocumentId_fkey";
DROP INDEX "tax_documents_tenantId_relatedDocumentId_idx";
DROP INDEX "tax_documents_tenantId_saleId_idx";
ALTER TABLE "tax_documents" DROP COLUMN "reasonCode", DROP COLUMN "reasonDescription", DROP COLUMN "relatedDocumentId";
CREATE UNIQUE INDEX "tax_documents_tenantId_saleId_key" ON "tax_documents"("tenantId", "saleId");
