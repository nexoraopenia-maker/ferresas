-- ===========================================================================
--  Códigos QR en productos + comprobantes electrónicos
-- ===========================================================================

-- --- 1. QR propio del negocio, aparte del código de barras del fabricante ---
ALTER TABLE "products" ADD COLUMN "qrCode" TEXT;
ALTER TABLE "product_variants" ADD COLUMN "qrCode" TEXT;

CREATE UNIQUE INDEX "products_tenantId_qrCode_key" ON "products"("tenantId", "qrCode");
CREATE UNIQUE INDEX "product_variants_tenantId_qrCode_key" ON "product_variants"("tenantId", "qrCode");

-- El escáner resuelve por QR igual que por barcode: índice parcial para que
-- la búsqueda no recorra las filas sin QR, que serán la mayoría.
CREATE INDEX "products_qrcode_lookup"
  ON "products" ("tenantId", "qrCode")
  WHERE "qrCode" IS NOT NULL AND "deletedAt" IS NULL;

-- --- 2. Estado tributario ---
CREATE TYPE "TaxDocumentStatus" AS ENUM ('PENDIENTE', 'ENVIADO', 'ACEPTADO', 'RECHAZADO', 'ANULADO');

-- --- 3. Comprobantes ---
CREATE TABLE "tax_documents" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "documentType" "DocumentType" NOT NULL,
    "series" TEXT NOT NULL,
    "correlativo" INTEGER NOT NULL,
    "fullNumber" TEXT NOT NULL,
    "status" "TaxDocumentStatus" NOT NULL DEFAULT 'PENDIENTE',
    "statusMessage" TEXT,
    "issuerTaxId" TEXT,
    "issuerLegalName" TEXT,
    "receiverDocType" "CustomerDocType" NOT NULL DEFAULT 'SIN_DOCUMENTO',
    "receiverDocNumber" TEXT,
    "receiverName" TEXT,
    "receiverAddress" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'PEN',
    "subtotal" DECIMAL(14,2) NOT NULL,
    "taxTotal" DECIMAL(14,2) NOT NULL,
    "discountTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL,
    "xmlHash" TEXT,
    "externalTicket" TEXT,
    "responseCode" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tax_documents_pkey" PRIMARY KEY ("id")
);

-- Un comprobante por venta.
CREATE UNIQUE INDEX "tax_documents_tenantId_saleId_key" ON "tax_documents"("tenantId", "saleId");

-- La restricción LEGAL: serie + correlativo únicos por tipo y por negocio.
-- Es la última línea de defensa si fallara el contador transaccional.
CREATE UNIQUE INDEX "tax_documents_tenantId_documentType_series_correlativo_key"
  ON "tax_documents"("tenantId", "documentType", "series", "correlativo");

CREATE INDEX "tax_documents_tenantId_status_issuedAt_idx"
  ON "tax_documents"("tenantId", "status", "issuedAt");
CREATE INDEX "tax_documents_tenantId_documentType_series_idx"
  ON "tax_documents"("tenantId", "documentType", "series");

-- FK COMPUESTA hacia la venta: un comprobante no puede apuntar a una venta
-- de otro tenant, igual que el resto del esquema.
ALTER TABLE "tax_documents"
  ADD CONSTRAINT "tax_documents_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tax_documents"
  ADD CONSTRAINT "tax_documents_tenantId_saleId_fkey"
  FOREIGN KEY ("tenantId", "saleId") REFERENCES "sales"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;
