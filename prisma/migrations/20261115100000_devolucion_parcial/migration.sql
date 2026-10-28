-- F6.2a · Devolución parcial por líneas: topes por línea, destino de lo devuelto y líneas propias de la nota de crédito parcial.
-- ADITIVA (expand): un tipo, una tabla y columnas nuevas; las columnas sin valor por defecto en el modelo se añaden con 0, se RELLENAN con la fórmula
-- de la venta (base = round(lineTotal / (1 + tasa)), igual que `sale-service`) y se les quita el valor por defecto. Después se añaden los CHECK.
-- Las filas de F6.1 (devoluciones totales) quedan coherentes: sus líneas figuran como devueltas por completo y su destino es STOCK
-- (SIN_STOCK si el producto no controla stock).

-- CreateEnum
CREATE TYPE "ReturnDestination" AS ENUM ('STOCK', 'MERMA', 'SIN_STOCK');

-- AlterTable
ALTER TABLE "sale_items" ADD COLUMN     "returnedAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "returnedQuantity" DECIMAL(14,4) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "sale_returns" ADD COLUMN     "returnTotal" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "sale_return_items" ADD COLUMN     "destination" "ReturnDestination" NOT NULL DEFAULT 'STOCK',
ADD COLUMN     "mermaId" TEXT,
ADD COLUMN     "subtotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "taxAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "taxRate" DECIMAL(5,4) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "tax_document_items" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "saleItemId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "unitType" "UnitType" NOT NULL,
    "quantity" DECIMAL(14,4) NOT NULL,
    "taxRate" DECIMAL(5,4) NOT NULL,
    "subtotal" DECIMAL(14,2) NOT NULL,
    "taxAmount" DECIMAL(14,2) NOT NULL,
    "total" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "tax_document_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tax_document_items_tenantId_documentId_idx" ON "tax_document_items"("tenantId", "documentId");

-- CreateIndex
CREATE INDEX "tax_document_items_tenantId_saleItemId_idx" ON "tax_document_items"("tenantId", "saleItemId");

-- CreateIndex
CREATE UNIQUE INDEX "tax_document_items_tenantId_documentId_lineNo_key" ON "tax_document_items"("tenantId", "documentId", "lineNo");

-- CreateIndex
CREATE INDEX "sale_return_items_tenantId_mermaId_idx" ON "sale_return_items"("tenantId", "mermaId");

-- AddForeignKey
ALTER TABLE "sale_return_items" ADD CONSTRAINT "sale_return_items_tenantId_mermaId_fkey" FOREIGN KEY ("tenantId", "mermaId") REFERENCES "mermas"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tax_document_items" ADD CONSTRAINT "tax_document_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_document_items" ADD CONSTRAINT "tax_document_items_tenantId_documentId_fkey" FOREIGN KEY ("tenantId", "documentId") REFERENCES "tax_documents"("tenantId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tax_document_items" ADD CONSTRAINT "tax_document_items_tenantId_saleItemId_fkey" FOREIGN KEY ("tenantId", "saleItemId") REFERENCES "sale_items"("tenantId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- ─── Rellenado de lo que ya existe (devoluciones totales de F6.1) ──────────────────────────────────────────────────────────────────
UPDATE "sale_returns" SET "returnTotal" = "saleTotal";

UPDATE "sale_return_items" ri
   SET "taxRate"   = si."taxRate",
       "subtotal"  = ROUND(si."lineTotal" / (1 + si."taxRate"), 2),
       "taxAmount" = si."lineTotal" - ROUND(si."lineTotal" / (1 + si."taxRate"), 2)
  FROM "sale_items" si
 WHERE si."tenantId" = ri."tenantId" AND si."id" = ri."saleItemId";

UPDATE "sale_return_items" ri
   SET "destination" = 'SIN_STOCK'
  FROM "sale_items" si
  JOIN "products" p ON p."tenantId" = si."tenantId" AND p."id" = si."productId"
 WHERE si."tenantId" = ri."tenantId" AND si."id" = ri."saleItemId" AND p."trackStock" = false;

UPDATE "sale_items" si
   SET "returnedQuantity" = r."q", "returnedAmount" = r."a"
  FROM (SELECT "tenantId", "saleItemId", SUM("quantity") AS "q", SUM("amount") AS "a" FROM "sale_return_items" GROUP BY 1, 2) r
 WHERE r."tenantId" = si."tenantId" AND r."saleItemId" = si."id";

ALTER TABLE "sale_returns" ALTER COLUMN "returnTotal" DROP DEFAULT;
ALTER TABLE "sale_return_items" ALTER COLUMN "subtotal" DROP DEFAULT, ALTER COLUMN "taxAmount" DROP DEFAULT, ALTER COLUMN "taxRate" DROP DEFAULT;

-- ─── CHECK ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- El tope duro por línea: lo devuelto nunca supera lo vendido, y devolver todas las unidades devuelve exactamente el importe de la línea.
ALTER TABLE "sale_items"
  ADD CONSTRAINT "sale_items_devuelto_chk" CHECK (
        "returnedQuantity" >= 0 AND "returnedQuantity" <= "quantity"
    AND "returnedAmount" >= 0 AND "returnedAmount" <= "lineTotal"
    AND ("returnedQuantity" < "quantity" OR "returnedAmount" = "lineTotal")
  );

ALTER TABLE "sale_returns"
  ADD CONSTRAINT "sale_returns_total_chk" CHECK ("returnTotal" >= 0 AND "returnTotal" <= "saleTotal");

-- Línea devuelta: cantidad positiva, base + IGV = importe, y «a merma» si y solo si apunta a su merma.
ALTER TABLE "sale_return_items"
  ADD CONSTRAINT "sale_return_items_importes_f62_chk" CHECK ("quantity" > 0 AND "amount" >= 0 AND "subtotal" >= 0 AND "taxAmount" >= 0 AND "amount" = "subtotal" + "taxAmount"),
  ADD CONSTRAINT "sale_return_items_merma_chk" CHECK (("destination" = 'MERMA') = ("mermaId" IS NOT NULL));

-- Línea de una nota de crédito parcial: cantidad positiva y total = base + IGV.
ALTER TABLE "tax_document_items"
  ADD CONSTRAINT "tax_document_items_importes_chk" CHECK ("quantity" > 0 AND "lineNo" > 0 AND "subtotal" >= 0 AND "taxAmount" >= 0 AND "total" > 0 AND "total" = "subtotal" + "taxAmount");
