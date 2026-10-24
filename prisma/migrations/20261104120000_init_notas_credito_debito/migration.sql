-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "DocumentType" ADD VALUE IF NOT EXISTS 'NOTA_CREDITO';
ALTER TYPE "DocumentType" ADD VALUE IF NOT EXISTS 'NOTA_DEBITO';

-- DropIndex
DROP INDEX "tax_documents_tenantId_saleId_key";

-- AlterTable
ALTER TABLE "tax_documents" ADD COLUMN     "reasonCode" TEXT,
ADD COLUMN     "reasonDescription" TEXT,
ADD COLUMN     "relatedDocumentId" TEXT;

-- CreateIndex
CREATE INDEX "tax_documents_tenantId_relatedDocumentId_idx" ON "tax_documents"("tenantId", "relatedDocumentId");

-- CreateIndex
CREATE INDEX "tax_documents_tenantId_saleId_idx" ON "tax_documents"("tenantId", "saleId");

-- AddForeignKey
ALTER TABLE "tax_documents" ADD CONSTRAINT "tax_documents_tenantId_relatedDocumentId_fkey" FOREIGN KEY ("tenantId", "relatedDocumentId") REFERENCES "tax_documents"("tenantId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;


-- ─── Lo que Prisma no sabe expresar (a mano) ───────────────────────────────────────────────────────
-- Se usan SOLO los valores antiguos del enum: los recién añadidos no pueden usarse en la misma transacción.

-- UN comprobante de venta (boleta o factura) por venta, como antes; las notas no cuentan.
-- Sustituye al único (tenantId, saleId) que se eliminó arriba.
CREATE UNIQUE INDEX "tax_documents_un_comprobante_por_venta"
  ON "tax_documents"("tenantId", "saleId")
  WHERE "documentType" IN ('BOLETA', 'FACTURA');

-- OJO: un CHECK que da NULL se CUMPLE; por eso cada campo obligatorio lleva su IS NOT NULL explícito.
-- Una nota (tipo distinto de nota de venta, boleta, factura y ticket) SIEMPRE lleva comprobante
-- relacionado, código de motivo de dos dígitos y sustento; el resto, NUNCA. Una nota no se relaciona consigo misma.
ALTER TABLE "tax_documents"
  ADD CONSTRAINT "tax_documents_nota_campos_chk" CHECK (
    (
      "documentType" IN ('NOTA_VENTA', 'BOLETA', 'FACTURA', 'TICKET')
      AND "relatedDocumentId" IS NULL AND "reasonCode" IS NULL AND "reasonDescription" IS NULL
    ) OR (
      "documentType" NOT IN ('NOTA_VENTA', 'BOLETA', 'FACTURA', 'TICKET')
      AND "relatedDocumentId" IS NOT NULL AND "relatedDocumentId" <> "id"
      AND "reasonCode" IS NOT NULL AND "reasonCode" ~ '^[0-9]{2}$'
      AND "reasonDescription" IS NOT NULL AND length(btrim("reasonDescription")) > 0
    )
  );
