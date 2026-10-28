-- F6.5b · Toma de inventario físico: revisión de diferencias y aplicación (aditiva).
--
-- Cada línea del conteo guarda lo que el sistema decía cuando se contó (el saldo del kardex a la hora de la última pasada vigente), la diferencia
-- (contado − sistema), cuántos movimientos hubo después, el costo con que se valoró el ajuste, quién la revisó y el movimiento de stock que la aplicó.
-- Sin tocar ninguna fila existente: todas las columnas son nulas (o falsas) por defecto.
--
-- `stock_movements(tenantId, id)` pasa a ser único para poder referenciarlo con clave compuesta: el movimiento de una línea es del MISMO negocio que el conteo.


-- AlterTable
ALTER TABLE "inventory_count_items" ADD COLUMN     "costAtApply" DECIMAL(12,4),
ADD COLUMN     "difference" DECIMAL(14,4),
ADD COLUMN     "movedSinceCount" INTEGER,
ADD COLUMN     "resultingMovementId" TEXT,
ADD COLUMN     "reviewNote" TEXT,
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedById" TEXT,
ADD COLUMN     "systemQtyAtCount" DECIMAL(14,4),
ADD COLUMN     "thresholdConfirmed" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "stock_movements_tenantId_id_key" ON "stock_movements"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "inventory_count_items" ADD CONSTRAINT "inventory_count_items_tenantId_resultingMovementId_fkey" FOREIGN KEY ("tenantId", "resultingMovementId") REFERENCES "stock_movements"("tenantId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "inventory_count_items" ADD CONSTRAINT "inventory_count_items_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Reglas de la base ───────────────────────────────────────────────────────────────────────────────────────────────

ALTER TABLE "inventory_count_items"
  -- Aprobar o rechazar lo hace una persona, en un momento.
  ADD CONSTRAINT "inventory_count_items_revision_chk" CHECK (
    "status" NOT IN ('APROBADO', 'RECHAZADO') OR ("reviewedAt" IS NOT NULL AND "reviewedById" IS NOT NULL)
  ),
  -- Mandar a recontar y rechazar exigen el motivo.
  ADD CONSTRAINT "inventory_count_items_motivo_chk" CHECK (
    "status" NOT IN ('RECHAZADO', 'RECONTAR') OR ("reviewNote" IS NOT NULL AND length(btrim("reviewNote")) >= 3)
  ),
  -- Solo se aprueba lo que tiene una cantidad contada.
  ADD CONSTRAINT "inventory_count_items_aprobado_chk" CHECK ("status" <> 'APROBADO' OR "countedQty" IS NOT NULL),
  -- La diferencia es exactamente contado − sistema al contar (y no existe sin sus dos términos).
  ADD CONSTRAINT "inventory_count_items_diferencia_chk" CHECK (
    "difference" IS NULL
    OR ("systemQtyAtCount" IS NOT NULL AND "countedQty" IS NOT NULL AND "difference" = "countedQty" - "systemQtyAtCount")
  ),
  -- Solo una línea aprobada, con diferencia distinta de cero, tiene un movimiento que la aplicó.
  ADD CONSTRAINT "inventory_count_items_movimiento_chk" CHECK (
    "resultingMovementId" IS NULL OR ("status" = 'APROBADO' AND "difference" IS NOT NULL AND "difference" <> 0)
  ),
  ADD CONSTRAINT "inventory_count_items_costo_chk" CHECK ("costAtApply" IS NULL OR "costAtApply" >= 0),
  ADD CONSTRAINT "inventory_count_items_movidos_chk" CHECK ("movedSinceCount" IS NULL OR "movedSinceCount" >= 0);
