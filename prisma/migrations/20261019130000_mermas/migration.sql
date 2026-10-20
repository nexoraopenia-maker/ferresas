-- ═══════════════════════════════════════════════════════════════════════════
--  MERMAS CON APROBACIÓN
-- ═══════════════════════════════════════════════════════════════════════════
--
--  Una merma reduce inventario a criterio de quien la registra, y esa es la
--  forma más fácil de tapar un faltante. Así que se parte en dos pasos:
--  el almacenero la SOLICITA (permiso `stock.merma_solicitar`) y alguien con
--  `stock.ajustar` la aprueba o la rechaza. Misma regla que en
--  transferencias: quien pide no autoriza.
--
--  POR QUÉ TABLA PROPIA Y NO UN StockMovement:
--  mientras está PENDIENTE el stock NO se ha movido. Un StockMovement es el
--  asiento de algo que ya pasó; esto es una petición. Mezclarlas obligaría a
--  tener movimientos que no cuentan para el saldo, y entonces
--  `SUM(movimientos) = stock` —el invariante que sostiene todo el
--  inventario— dejaría de cumplirse. Al aprobarse SÍ se crea el movimiento.
-- ───────────────────────────────────────────────────────────────────────────

CREATE TYPE "MermaStatus" AS ENUM ('PENDIENTE', 'APROBADA', 'RECHAZADA');

CREATE TABLE "mermas" (
  "id"            TEXT NOT NULL,
  "tenantId"      TEXT NOT NULL,
  "branchId"      TEXT NOT NULL,
  "warehouseId"   TEXT NOT NULL,
  "productId"     TEXT NOT NULL,
  "variantId"     TEXT,
  "nameSnapshot"  TEXT NOT NULL,
  "skuSnapshot"   TEXT NOT NULL,
  "unitType"      "UnitType" NOT NULL DEFAULT 'UNIDAD',
  "quantity"      DECIMAL(14,4) NOT NULL,
  "reason"        TEXT NOT NULL,
  "photoUrl"      TEXT,
  "status"        "MermaStatus" NOT NULL DEFAULT 'PENDIENTE',
  "requestedById" TEXT NOT NULL,
  "resolvedById"  TEXT,
  "rejectReason"  TEXT,
  "movementId"    TEXT,
  "requestedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt"    TIMESTAMP(3),
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "mermas_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mermas_tenantId_id_key" ON "mermas" ("tenantId", "id");
-- El contador del panel del administrador consulta por (tenant, estado).
CREATE INDEX "mermas_tenantId_status_requestedAt_idx"
  ON "mermas" ("tenantId", "status", "requestedAt");
CREATE INDEX "mermas_tenantId_branchId_status_idx"
  ON "mermas" ("tenantId", "branchId", "status");
CREATE INDEX "mermas_tenantId_productId_idx" ON "mermas" ("tenantId", "productId");

ALTER TABLE "mermas"
  ADD CONSTRAINT "mermas_tenantId_fkey" FOREIGN KEY ("tenantId")
    REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "mermas_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId")
    REFERENCES "branches" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "mermas_tenantId_warehouseId_fkey" FOREIGN KEY ("tenantId", "warehouseId")
    REFERENCES "warehouses" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "mermas_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId")
    REFERENCES "products" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "mermas_tenantId_variantId_fkey" FOREIGN KEY ("tenantId", "variantId")
    REFERENCES "product_variants" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "mermas_requestedById_fkey" FOREIGN KEY ("requestedById")
    REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "mermas_resolvedById_fkey" FOREIGN KEY ("resolvedById")
    REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
