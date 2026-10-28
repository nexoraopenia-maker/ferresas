-- F6.5a · Toma de inventario físico (aditiva): conteos, sus líneas y sus pasadas.
--
-- Un conteo es de UN almacén y tiene ciclo de vida BORRADOR → EN_CONTEO → EN_REVISION → APLICADO (o CANCELADO desde cualquier estado previo a APLICADO).
-- Solo puede haber un conteo abierto (borrador, en conteo o en revisión) por almacén: lo garantiza un índice único parcial. Las líneas guardan la foto del stock
-- al empezar; las pasadas (lo que cada persona cuenta, con su zona libre) solo se agregan y se anulan, nunca se borran.
-- Los valores del enum de líneas de F6.5b (RECONTAR, APROBADO, RECHAZADO) se crean ya: Postgres no deja usar un valor de enum recién creado en su misma transacción.


-- CreateEnum
CREATE TYPE "InventoryCountStatus" AS ENUM ('BORRADOR', 'EN_CONTEO', 'EN_REVISION', 'APLICADO', 'CANCELADO');

-- CreateEnum
CREATE TYPE "InventoryCountScope" AS ENUM ('TOTAL', 'CATEGORIA', 'SELECCION');

-- CreateEnum
CREATE TYPE "InventoryCountMode" AS ENUM ('CIEGO', 'GUIADO');

-- CreateEnum
CREATE TYPE "InventoryCountItemStatus" AS ENUM ('PENDIENTE', 'CONTADO', 'RECONTAR', 'APROBADO', 'RECHAZADO');

-- CreateTable
CREATE TABLE "inventory_counts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "scope" "InventoryCountScope" NOT NULL,
    "categoryId" TEXT,
    "mode" "InventoryCountMode" NOT NULL DEFAULT 'CIEGO',
    "status" "InventoryCountStatus" NOT NULL DEFAULT 'BORRADOR',
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "startedById" TEXT,
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "appliedAt" TIMESTAMP(3),
    "appliedById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelReason" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_counts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_count_items" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "countId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "nameSnapshot" TEXT NOT NULL,
    "skuSnapshot" TEXT NOT NULL,
    "unitType" "UnitType" NOT NULL,
    "systemQtyAtStart" DECIMAL(14,4),
    "countedQty" DECIMAL(14,4),
    "status" "InventoryCountItemStatus" NOT NULL DEFAULT 'PENDIENTE',
    "lastCountedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_count_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_count_entries" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "countId" TEXT NOT NULL,
    "quantity" DECIMAL(14,4) NOT NULL,
    "presentationId" TEXT,
    "enteredQuantity" DECIMAL(14,4),
    "presentationFactor" DECIMAL(14,6),
    "zone" TEXT,
    "userId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "voidedAt" TIMESTAMP(3),
    "voidedById" TEXT,
    "voidReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_count_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inventory_counts_tenantId_warehouseId_status_idx" ON "inventory_counts"("tenantId", "warehouseId", "status");

-- CreateIndex
CREATE INDEX "inventory_counts_tenantId_branchId_createdAt_idx" ON "inventory_counts"("tenantId", "branchId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_counts_tenantId_id_key" ON "inventory_counts"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_counts_tenantId_number_key" ON "inventory_counts"("tenantId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_counts_tenantId_idempotencyKey_key" ON "inventory_counts"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "inventory_count_items_tenantId_countId_status_idx" ON "inventory_count_items"("tenantId", "countId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_count_items_tenantId_id_key" ON "inventory_count_items"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_count_items_tenantId_id_countId_key" ON "inventory_count_items"("tenantId", "id", "countId");

-- CreateIndex
CREATE INDEX "inventory_count_entries_tenantId_itemId_idx" ON "inventory_count_entries"("tenantId", "itemId");

-- CreateIndex
CREATE INDEX "inventory_count_entries_tenantId_countId_createdAt_idx" ON "inventory_count_entries"("tenantId", "countId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_count_entries_tenantId_id_key" ON "inventory_count_entries"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_count_entries_tenantId_idempotencyKey_key" ON "inventory_count_entries"("tenantId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "inventory_counts" ADD CONSTRAINT "inventory_counts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_counts" ADD CONSTRAINT "inventory_counts_tenantId_warehouseId_fkey" FOREIGN KEY ("tenantId", "warehouseId") REFERENCES "warehouses"("tenantId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "inventory_counts" ADD CONSTRAINT "inventory_counts_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "branches"("tenantId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "inventory_counts" ADD CONSTRAINT "inventory_counts_tenantId_categoryId_fkey" FOREIGN KEY ("tenantId", "categoryId") REFERENCES "categories"("tenantId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "inventory_counts" ADD CONSTRAINT "inventory_counts_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_counts" ADD CONSTRAINT "inventory_counts_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_counts" ADD CONSTRAINT "inventory_counts_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_counts" ADD CONSTRAINT "inventory_counts_appliedById_fkey" FOREIGN KEY ("appliedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_counts" ADD CONSTRAINT "inventory_counts_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_count_items" ADD CONSTRAINT "inventory_count_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_count_items" ADD CONSTRAINT "inventory_count_items_tenantId_countId_fkey" FOREIGN KEY ("tenantId", "countId") REFERENCES "inventory_counts"("tenantId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "inventory_count_items" ADD CONSTRAINT "inventory_count_items_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "inventory_count_items" ADD CONSTRAINT "inventory_count_items_tenantId_variantId_fkey" FOREIGN KEY ("tenantId", "variantId") REFERENCES "product_variants"("tenantId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "inventory_count_entries" ADD CONSTRAINT "inventory_count_entries_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_count_entries" ADD CONSTRAINT "inventory_count_entries_tenantId_itemId_countId_fkey" FOREIGN KEY ("tenantId", "itemId", "countId") REFERENCES "inventory_count_items"("tenantId", "id", "countId") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "inventory_count_entries" ADD CONSTRAINT "inventory_count_entries_tenantId_presentationId_fkey" FOREIGN KEY ("tenantId", "presentationId") REFERENCES "product_presentations"("tenantId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "inventory_count_entries" ADD CONSTRAINT "inventory_count_entries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_count_entries" ADD CONSTRAINT "inventory_count_entries_voidedById_fkey" FOREIGN KEY ("voidedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Reglas de la base ───────────────────────────────────────────────────────────────────────────────────────────────

-- Un solo conteo abierto por almacén.
CREATE UNIQUE INDEX "inventory_counts_uno_abierto" ON "inventory_counts"("tenantId", "warehouseId") WHERE "status" IN ('BORRADOR', 'EN_CONTEO', 'EN_REVISION');

-- Una línea por producto (y variante) en cada conteo (un NULL es distinto de otro: dos índices parciales, como en `stocks`).
CREATE UNIQUE INDEX "inventory_count_items_sin_variante_key" ON "inventory_count_items"("tenantId", "countId", "productId") WHERE "variantId" IS NULL;
CREATE UNIQUE INDEX "inventory_count_items_con_variante_key" ON "inventory_count_items"("tenantId", "countId", "productId", "variantId") WHERE "variantId" IS NOT NULL;

ALTER TABLE "inventory_counts"
  ADD CONSTRAINT "inventory_counts_numero_chk" CHECK (length(btrim("number")) > 0),
  -- Categoría si y solo si el alcance es por categoría.
  ADD CONSTRAINT "inventory_counts_alcance_chk" CHECK (("scope" = 'CATEGORIA') = ("categoryId" IS NOT NULL)),
  -- Coherencia entre el estado y sus fechas/personas: un borrador no ha empezado; en conteo, en revisión y aplicado sí; en revisión y aplicado ya se cerró.
  ADD CONSTRAINT "inventory_counts_inicio_chk" CHECK (
    ("status" = 'BORRADOR' AND "startedAt" IS NULL AND "startedById" IS NULL)
    OR ("status" IN ('EN_CONTEO', 'EN_REVISION', 'APLICADO') AND "startedAt" IS NOT NULL AND "startedById" IS NOT NULL)
    OR "status" = 'CANCELADO'
  ),
  ADD CONSTRAINT "inventory_counts_cierre_chk" CHECK (
    ("status" IN ('EN_REVISION', 'APLICADO') AND "closedAt" IS NOT NULL AND "closedById" IS NOT NULL)
    OR ("status" IN ('BORRADOR', 'EN_CONTEO') AND "closedAt" IS NULL AND "closedById" IS NULL)
    OR "status" = 'CANCELADO'
  ),
  ADD CONSTRAINT "inventory_counts_aplicacion_chk" CHECK (
    ("status" = 'APLICADO' AND "appliedAt" IS NOT NULL AND "appliedById" IS NOT NULL)
    OR ("status" <> 'APLICADO' AND "appliedAt" IS NULL AND "appliedById" IS NULL)
  ),
  -- Cancelar siempre con quién, cuándo y por qué.
  ADD CONSTRAINT "inventory_counts_cancelacion_chk" CHECK (
    ("status" = 'CANCELADO' AND "cancelledAt" IS NOT NULL AND "cancelledById" IS NOT NULL AND "cancelReason" IS NOT NULL AND length(btrim("cancelReason")) >= 3)
    OR ("status" <> 'CANCELADO' AND "cancelledAt" IS NULL AND "cancelledById" IS NULL AND "cancelReason" IS NULL)
  );

ALTER TABLE "inventory_count_items"
  ADD CONSTRAINT "inventory_count_items_contado_chk" CHECK ("countedQty" IS NULL OR "countedQty" >= 0),
  -- Pendiente = sin contar; contado = con cantidad.
  ADD CONSTRAINT "inventory_count_items_estado_chk" CHECK (
    ("status" <> 'PENDIENTE' OR "countedQty" IS NULL) AND ("status" <> 'CONTADO' OR "countedQty" IS NOT NULL)
  );

ALTER TABLE "inventory_count_entries"
  ADD CONSTRAINT "inventory_count_entries_cantidad_chk" CHECK ("quantity" >= 0),
  -- La cantidad base es lo ingresado por el factor (contar «cero cajas» también es contar).
  ADD CONSTRAINT "inventory_count_entries_presentacion_chk" CHECK (
    ("presentationId" IS NULL AND "enteredQuantity" IS NULL AND "presentationFactor" IS NULL)
    OR ("presentationId" IS NOT NULL AND "enteredQuantity" IS NOT NULL AND "presentationFactor" IS NOT NULL AND "enteredQuantity" >= 0 AND "presentationFactor" > 0 AND "quantity" = "enteredQuantity" * "presentationFactor")
  ),
  ADD CONSTRAINT "inventory_count_entries_zona_chk" CHECK ("zone" IS NULL OR (length(btrim("zone")) > 0 AND length("zone") <= 40)),
  -- Anular siempre con quién, cuándo y por qué.
  ADD CONSTRAINT "inventory_count_entries_anulacion_chk" CHECK (
    ("voidedAt" IS NULL AND "voidedById" IS NULL AND "voidReason" IS NULL)
    OR ("voidedAt" IS NOT NULL AND "voidedById" IS NOT NULL AND "voidReason" IS NOT NULL AND length(btrim("voidReason")) >= 3)
  );
