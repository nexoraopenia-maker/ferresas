-- CreateEnum
CREATE TYPE "GuideMotive" AS ENUM ('VENTA', 'COMPRA', 'TRASLADO_ESTABLECIMIENTOS', 'OTROS');

-- CreateEnum
CREATE TYPE "GuideTransportMode" AS ENUM ('PUBLICO', 'PRIVADO');

-- CreateTable
CREATE TABLE "dispatch_guides" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "saleId" TEXT,
    "transferId" TEXT,
    "series" TEXT NOT NULL,
    "correlativo" INTEGER NOT NULL,
    "fullNumber" TEXT NOT NULL,
    "motive" "GuideMotive" NOT NULL,
    "motiveDetail" TEXT,
    "transportMode" "GuideTransportMode" NOT NULL,
    "issueDate" DATE NOT NULL,
    "transferStartDate" DATE NOT NULL,
    "grossWeightKg" DECIMAL(12,3) NOT NULL,
    "packages" INTEGER,
    "issuerTaxId" TEXT NOT NULL,
    "issuerLegalName" TEXT NOT NULL,
    "recipientDocType" "CustomerDocType" NOT NULL,
    "recipientDocNumber" TEXT NOT NULL,
    "recipientName" TEXT NOT NULL,
    "originAddress" TEXT NOT NULL,
    "originUbigeo" TEXT NOT NULL,
    "destinationAddress" TEXT NOT NULL,
    "destinationUbigeo" TEXT NOT NULL,
    "carrierRuc" TEXT,
    "carrierName" TEXT,
    "vehiclePlate" TEXT,
    "driverDocType" "CustomerDocType",
    "driverDocNumber" TEXT,
    "driverName" TEXT,
    "driverLicense" TEXT,
    "notes" TEXT,
    "status" "TaxDocumentStatus" NOT NULL DEFAULT 'PENDIENTE',
    "statusMessage" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dispatch_guides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispatch_guide_items" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "guideId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "nameSnapshot" TEXT NOT NULL,
    "skuSnapshot" TEXT NOT NULL,
    "unitType" "UnitType" NOT NULL DEFAULT 'UNIDAD',
    "quantity" DECIMAL(14,4) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispatch_guide_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dispatch_guides_tenantId_branchId_issueDate_idx" ON "dispatch_guides"("tenantId", "branchId", "issueDate");

-- CreateIndex
CREATE INDEX "dispatch_guides_tenantId_saleId_idx" ON "dispatch_guides"("tenantId", "saleId");

-- CreateIndex
CREATE INDEX "dispatch_guides_tenantId_transferId_idx" ON "dispatch_guides"("tenantId", "transferId");

-- CreateIndex
CREATE UNIQUE INDEX "dispatch_guides_tenantId_id_key" ON "dispatch_guides"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "dispatch_guides_tenantId_series_correlativo_key" ON "dispatch_guides"("tenantId", "series", "correlativo");

-- CreateIndex
CREATE INDEX "dispatch_guide_items_tenantId_guideId_idx" ON "dispatch_guide_items"("tenantId", "guideId");

-- CreateIndex
CREATE INDEX "dispatch_guide_items_tenantId_productId_idx" ON "dispatch_guide_items"("tenantId", "productId");

-- AddForeignKey
ALTER TABLE "dispatch_guides" ADD CONSTRAINT "dispatch_guides_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_guides" ADD CONSTRAINT "dispatch_guides_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "branches"("tenantId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "dispatch_guides" ADD CONSTRAINT "dispatch_guides_tenantId_saleId_fkey" FOREIGN KEY ("tenantId", "saleId") REFERENCES "sales"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "dispatch_guides" ADD CONSTRAINT "dispatch_guides_tenantId_transferId_fkey" FOREIGN KEY ("tenantId", "transferId") REFERENCES "branch_transfers"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "dispatch_guides" ADD CONSTRAINT "dispatch_guides_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_guide_items" ADD CONSTRAINT "dispatch_guide_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_guide_items" ADD CONSTRAINT "dispatch_guide_items_tenantId_guideId_fkey" FOREIGN KEY ("tenantId", "guideId") REFERENCES "dispatch_guides"("tenantId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "dispatch_guide_items" ADD CONSTRAINT "dispatch_guide_items_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

