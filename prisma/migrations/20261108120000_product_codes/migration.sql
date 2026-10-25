-- CreateEnum
CREATE TYPE "ProductCodeType" AS ENUM ('EAN13', 'EAN8', 'UPC', 'CODE128', 'QR', 'INTERNO');

-- CreateTable
CREATE TABLE "product_codes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "presentationId" TEXT,
    "code" TEXT NOT NULL,
    "type" "ProductCodeType" NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_codes_tenantId_productId_idx" ON "product_codes"("tenantId", "productId");

-- CreateIndex
CREATE INDEX "product_codes_tenantId_variantId_idx" ON "product_codes"("tenantId", "variantId");

-- CreateIndex
CREATE UNIQUE INDEX "product_codes_tenantId_code_key" ON "product_codes"("tenantId", "code");

-- AddForeignKey
ALTER TABLE "product_codes" ADD CONSTRAINT "product_codes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_codes" ADD CONSTRAINT "product_codes_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "product_codes" ADD CONSTRAINT "product_codes_tenantId_variantId_fkey" FOREIGN KEY ("tenantId", "variantId") REFERENCES "product_variants"("tenantId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;


-- ─── Lo que Prisma no sabe expresar (a mano) ──────────────────────────────────────────────────────────

-- Como mucho UN código principal por dueño (producto, variante o presentación).
CREATE UNIQUE INDEX "product_codes_un_principal_por_dueno"
  ON "product_codes"("tenantId", "productId", COALESCE("variantId", ''), COALESCE("presentationId", ''))
  WHERE "isPrimary";

-- Un código es texto no vacío y sin espacios en los extremos: lo que lee el escáner se compara tal cual.
ALTER TABLE "product_codes"
  ADD CONSTRAINT "product_codes_codigo_limpio_chk" CHECK (length(btrim("code")) > 0 AND "code" = btrim("code"));
