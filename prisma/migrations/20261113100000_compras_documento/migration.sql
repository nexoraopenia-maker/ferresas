-- F5.4 · Documento del proveedor estructurado en las compras (tipo, serie, número y fecha de emisión).
-- ADITIVA: columnas nulas. Las compras anteriores quedan con los cuatro campos vacíos y se completan con «Completar documento».

-- CreateEnum
CREATE TYPE "PurchaseDocType" AS ENUM ('FACTURA', 'BOLETA', 'NOTA_CREDITO', 'NOTA_DEBITO', 'RECIBO_HONORARIOS', 'OTRO');

-- AlterTable
ALTER TABLE "purchases" ADD COLUMN     "docNumber" VARCHAR(20),
ADD COLUMN     "docSeries" VARCHAR(20),
ADD COLUMN     "docType" "PurchaseDocType",
ADD COLUMN     "issueDate" DATE;

-- CreateIndex
CREATE INDEX "purchases_tenantId_issueDate_idx" ON "purchases"("tenantId", "issueDate");


-- Los cuatro campos del documento van juntos o ninguno, y con formato válido: serie y número en mayúsculas/dígitos, sin espacios ni guiones
-- (el guion es el separador de `invoiceRef`, que se compone como SERIE-NÚMERO). Las filas existentes (todo nulo) lo cumplen.
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_documento_completo_chk" CHECK (
  ("docType" IS NULL AND "docSeries" IS NULL AND "docNumber" IS NULL AND "issueDate" IS NULL)
  OR ("docType" IS NOT NULL AND "docSeries" IS NOT NULL AND "docNumber" IS NOT NULL AND "issueDate" IS NOT NULL)
);

ALTER TABLE "purchases" ADD CONSTRAINT "purchases_documento_formato_chk" CHECK (
  ("docSeries" IS NULL OR "docSeries" ~ '^[A-Z0-9]{1,20}$') AND ("docNumber" IS NULL OR "docNumber" ~ '^[A-Z0-9]{1,20}$')
);
