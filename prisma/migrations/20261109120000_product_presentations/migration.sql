-- AlterTable
ALTER TABLE "stock_movements" ADD COLUMN     "enteredQuantity" DECIMAL(14,4),
ADD COLUMN     "presentationFactor" DECIMAL(14,6),
ADD COLUMN     "presentationId" TEXT;

-- AlterTable
ALTER TABLE "sale_items" ADD COLUMN     "enteredQuantity" DECIMAL(14,4),
ADD COLUMN     "presentationFactor" DECIMAL(14,6),
ADD COLUMN     "presentationId" TEXT,
ADD COLUMN     "presentationName" TEXT;

-- AlterTable
ALTER TABLE "purchase_items" ADD COLUMN     "enteredQuantity" DECIMAL(14,4),
ADD COLUMN     "presentationFactor" DECIMAL(14,6),
ADD COLUMN     "presentationId" TEXT,
ADD COLUMN     "presentationName" TEXT;

-- CreateTable
CREATE TABLE "product_presentations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unitType" "UnitType" NOT NULL,
    "factor" DECIMAL(14,6) NOT NULL,
    "salePrice" DECIMAL(12,4),
    "costPrice" DECIMAL(12,4),
    "isDefaultSale" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "product_presentations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_presentations_tenantId_productId_idx" ON "product_presentations"("tenantId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "product_presentations_tenantId_id_key" ON "product_presentations"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "product_presentations_tenantId_productId_name_key" ON "product_presentations"("tenantId", "productId", "name");

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tenantId_presentationId_fkey" FOREIGN KEY ("tenantId", "presentationId") REFERENCES "product_presentations"("tenantId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_tenantId_presentationId_fkey" FOREIGN KEY ("tenantId", "presentationId") REFERENCES "product_presentations"("tenantId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_tenantId_presentationId_fkey" FOREIGN KEY ("tenantId", "presentationId") REFERENCES "product_presentations"("tenantId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "product_codes" ADD CONSTRAINT "product_codes_tenantId_presentationId_fkey" FOREIGN KEY ("tenantId", "presentationId") REFERENCES "product_presentations"("tenantId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "product_presentations" ADD CONSTRAINT "product_presentations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_presentations" ADD CONSTRAINT "product_presentations_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;


-- ─── Lo que Prisma no sabe expresar (a mano) ──────────────────────────────────────────────────────────

-- Una presentación convierte: el factor es cuántas unidades base contiene, y tiene que ser positivo.
ALTER TABLE "product_presentations"
  ADD CONSTRAINT "product_presentations_factor_chk" CHECK ("factor" > 0),
  ADD CONSTRAINT "product_presentations_nombre_chk" CHECK (length(btrim("name")) > 0 AND "name" = btrim("name")),
  ADD CONSTRAINT "product_presentations_precios_chk" CHECK (("salePrice" IS NULL OR "salePrice" >= 0) AND ("costPrice" IS NULL OR "costPrice" >= 0)),
  -- La de venta por defecto tiene que estar activa.
  ADD CONSTRAINT "product_presentations_defecto_activa_chk" CHECK (NOT "isDefaultSale" OR "isActive");

-- Como mucho UNA presentación de venta por defecto por producto (las dadas de baja no cuentan).
CREATE UNIQUE INDEX "product_presentations_una_por_defecto"
  ON "product_presentations"("tenantId", "productId")
  WHERE "isDefaultSale" AND "deletedAt" IS NULL;

-- Trazabilidad de las líneas: las columnas de la presentación van TODAS o NINGUNA, y la cantidad base es EXACTAMENTE lo
-- ingresado por el factor (la matemática de src/features/inventory/conversion.ts, comprobada también en la base).
ALTER TABLE "sale_items"
  ADD CONSTRAINT "sale_items_presentacion_chk" CHECK (
    ("presentationId" IS NULL AND "enteredQuantity" IS NULL AND "presentationFactor" IS NULL AND "presentationName" IS NULL)
    OR ("presentationId" IS NOT NULL AND "enteredQuantity" > 0 AND "presentationFactor" > 0 AND "presentationName" IS NOT NULL
        AND "quantity" = "enteredQuantity" * "presentationFactor")
  );

ALTER TABLE "purchase_items"
  ADD CONSTRAINT "purchase_items_presentacion_chk" CHECK (
    ("presentationId" IS NULL AND "enteredQuantity" IS NULL AND "presentationFactor" IS NULL AND "presentationName" IS NULL)
    OR ("presentationId" IS NOT NULL AND "enteredQuantity" > 0 AND "presentationFactor" > 0 AND "presentationName" IS NOT NULL
        AND "quantity" = "enteredQuantity" * "presentationFactor")
  );

-- Un movimiento puede ser de salida (negativo): la cantidad base sigue siendo lo ingresado por el factor, con su signo.
ALTER TABLE "stock_movements"
  ADD CONSTRAINT "stock_movements_presentacion_chk" CHECK (
    ("presentationId" IS NULL AND "enteredQuantity" IS NULL AND "presentationFactor" IS NULL)
    OR ("presentationId" IS NOT NULL AND "enteredQuantity" <> 0 AND "presentationFactor" > 0
        AND "quantity" = "enteredQuantity" * "presentationFactor")
  );
