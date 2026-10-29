-- F6.7a · Listas de precio y precio por volumen (aditiva).
--
-- Tres tablas nuevas (`price_lists`, `price_list_entries`, `price_tiers`) y columnas nulas en `customers`, `sales`, `quotes` y `sale_items`. Sin tocar ninguna fila existente: mientras
-- no se cree una lista, la venta se comporta exactamente igual que hoy. La lista Base/Minorista NO es una fila: es `priceListId` NULL y su precio es `products.salePrice`.
--
-- Los CHECK usan `IS NOT NULL` explícito donde una columna puede ser nula: un CHECK cuyo resultado es NULL APRUEBA. Dos índices únicos son PARCIALES (el nombre de lista sin distinguir
-- mayúsculas, y los tramos de la lista Base, cuyo `priceListId` es NULL y PostgreSQL trata cada NULL como distinto) y Prisma no los puede expresar.


-- CreateEnum
CREATE TYPE "PriceSource" AS ENUM ('BASE', 'LISTA', 'VOLUMEN');

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "priceListId" TEXT;

-- AlterTable
ALTER TABLE "quotes" ADD COLUMN     "priceListId" TEXT;

-- AlterTable
ALTER TABLE "sale_items" ADD COLUMN     "priceSource" "PriceSource",
ADD COLUMN     "tierMinQuantity" DECIMAL(14,4);

-- AlterTable
ALTER TABLE "sales" ADD COLUMN     "priceListId" TEXT;

-- CreateTable
CREATE TABLE "price_lists" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "price_lists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_list_entries" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "priceListId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "price" DECIMAL(12,4),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "price_list_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_tiers" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "priceListId" TEXT,
    "productId" TEXT NOT NULL,
    "minQuantity" DECIMAL(14,4) NOT NULL,
    "unitPrice" DECIMAL(12,4) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "price_tiers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "price_lists_tenantId_isActive_idx" ON "price_lists"("tenantId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "price_lists_tenantId_id_key" ON "price_lists"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "price_lists_tenantId_code_key" ON "price_lists"("tenantId", "code");

-- CreateIndex
CREATE INDEX "price_list_entries_tenantId_productId_idx" ON "price_list_entries"("tenantId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "price_list_entries_tenantId_priceListId_productId_key" ON "price_list_entries"("tenantId", "priceListId", "productId");

-- CreateIndex
CREATE INDEX "price_tiers_tenantId_productId_idx" ON "price_tiers"("tenantId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "price_tiers_tenantId_priceListId_productId_minQuantity_key" ON "price_tiers"("tenantId", "priceListId", "productId", "minQuantity");

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_tenantId_priceListId_fkey" FOREIGN KEY ("tenantId", "priceListId") REFERENCES "price_lists"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_tenantId_priceListId_fkey" FOREIGN KEY ("tenantId", "priceListId") REFERENCES "price_lists"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_tenantId_priceListId_fkey" FOREIGN KEY ("tenantId", "priceListId") REFERENCES "price_lists"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_list_entries" ADD CONSTRAINT "price_list_entries_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_list_entries" ADD CONSTRAINT "price_list_entries_tenantId_priceListId_fkey" FOREIGN KEY ("tenantId", "priceListId") REFERENCES "price_lists"("tenantId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "price_list_entries" ADD CONSTRAINT "price_list_entries_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "price_tiers" ADD CONSTRAINT "price_tiers_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_tiers" ADD CONSTRAINT "price_tiers_tenantId_priceListId_fkey" FOREIGN KEY ("tenantId", "priceListId") REFERENCES "price_lists"("tenantId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "price_tiers" ADD CONSTRAINT "price_tiers_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "price_tiers" ADD CONSTRAINT "price_tiers_tenantId_priceListId_productId_fkey" FOREIGN KEY ("tenantId", "priceListId", "productId") REFERENCES "price_list_entries"("tenantId", "priceListId", "productId") ON DELETE CASCADE ON UPDATE NO ACTION;

-- CheckConstraints · listas
ALTER TABLE "price_lists"
  ADD CONSTRAINT "price_lists_nombre_chk" CHECK (length(btrim("name")) BETWEEN 2 AND 40),
  ADD CONSTRAINT "price_lists_codigo_chk" CHECK ("code" IS NULL OR "code" ~ '^[A-Za-z0-9_-]{1,30}$');

-- CheckConstraints · entradas y tramos
ALTER TABLE "price_list_entries"
  ADD CONSTRAINT "price_list_entries_precio_chk" CHECK ("price" IS NULL OR "price" >= 0);
ALTER TABLE "price_tiers"
  ADD CONSTRAINT "price_tiers_cantidad_chk" CHECK ("minQuantity" > 0),
  ADD CONSTRAINT "price_tiers_precio_chk" CHECK ("unitPrice" >= 0);

-- CheckConstraint · la línea vendida: el tramo aplicado va si y solo si la fuente del precio es VOLUMEN (y las ventas anteriores no traen ninguno de los dos).
ALTER TABLE "sale_items"
  ADD CONSTRAINT "sale_items_fuente_precio_chk" CHECK (
        ("priceSource" IS NULL AND "tierMinQuantity" IS NULL)
     OR ("priceSource" IS NOT NULL AND "priceSource" = 'VOLUMEN' AND "tierMinQuantity" IS NOT NULL AND "tierMinQuantity" > 0)
     OR ("priceSource" IS NOT NULL AND "priceSource" <> 'VOLUMEN' AND "tierMinQuantity" IS NULL)
  );

-- Índices únicos parciales
CREATE UNIQUE INDEX "price_lists_name_uniq" ON "price_lists" ("tenantId", lower("name")) WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX "price_tiers_base_uniq" ON "price_tiers" ("tenantId", "productId", "minQuantity") WHERE "priceListId" IS NULL;

-- Índices de apoyo a las búsquedas por lista
CREATE INDEX "customers_tenantId_priceListId_idx" ON "customers"("tenantId", "priceListId") WHERE "priceListId" IS NOT NULL;
