-- ═══════════════════════════════════════════════════════════════════════════
--  SUCURSALES, TURNOS DE CAJA Y TRANSFERENCIAS
-- ═══════════════════════════════════════════════════════════════════════════
--
--  Migración escrita a mano porque `prisma migrate dev` es interactivo y
--  porque aquí hay un BACKFILL que ninguna generación automática haría bien:
--  las columnas `branchId` son NOT NULL, y hay datos en producción.
--
--  Estrategia en tres pasos, el único orden que no rompe nada:
--    1. columna NULLABLE
--    2. relleno desde la sucursal creada para cada tenant
--    3. SET NOT NULL
--
--  Retrocompatibilidad de los correlativos: la sucursal del backfill recibe
--  seriesNumber = 1, y de ahí sale exactamente la serie "001" que ya usan
--  todos los documentos emitidos. Ni un número cambia.
-- ───────────────────────────────────────────────────────────────────────────

CREATE TYPE "CashSessionStatus" AS ENUM ('ABIERTA', 'CERRADA');

CREATE TYPE "TransferStatus" AS ENUM (
  'BORRADOR', 'SOLICITADA', 'APROBADA', 'EN_TRANSITO',
  'RECIBIDA', 'RECHAZADA', 'CANCELADA'
);

-- ── Límite de sucursales por plan ──────────────────────────────────────────
ALTER TABLE "plans" ADD COLUMN "maxBranches" INTEGER;

-- ── Sucursales ─────────────────────────────────────────────────────────────
CREATE TABLE "branches" (
  "id"                TEXT NOT NULL,
  "tenantId"          TEXT NOT NULL,
  "code"              TEXT NOT NULL,
  "name"              TEXT NOT NULL,
  "establishmentCode" TEXT NOT NULL,
  "seriesNumber"      INTEGER NOT NULL,
  "address"           TEXT,
  "ubigeo"            TEXT,
  "phone"             TEXT,
  "email"             TEXT,
  "managerId"         TEXT,
  "isDefault"         BOOLEAN NOT NULL DEFAULT false,
  "isActive"          BOOLEAN NOT NULL DEFAULT true,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt"         TIMESTAMP(3),
  CONSTRAINT "branches_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "branches_tenantId_id_key" ON "branches" ("tenantId", "id");
CREATE UNIQUE INDEX "branches_tenantId_code_key" ON "branches" ("tenantId", "code");
CREATE UNIQUE INDEX "branches_tenantId_establishmentCode_key"
  ON "branches" ("tenantId", "establishmentCode");
CREATE UNIQUE INDEX "branches_tenantId_seriesNumber_key"
  ON "branches" ("tenantId", "seriesNumber");
CREATE INDEX "branches_tenantId_isActive_idx" ON "branches" ("tenantId", "isActive");
CREATE INDEX "branches_tenantId_deletedAt_idx" ON "branches" ("tenantId", "deletedAt");

ALTER TABLE "branches"
  ADD CONSTRAINT "branches_tenantId_fkey" FOREIGN KEY ("tenantId")
    REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "branches_managerId_fkey" FOREIGN KEY ("managerId")
    REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── BACKFILL: una casa matriz por cada tenant que ya existe ────────────────
-- gen_random_uuid() en lugar de cuid(): cuid() es de Prisma y no existe en
-- SQL. Las filas nuevas sí llevarán cuid; la columna es TEXT y admite ambos.
INSERT INTO "branches" ("id", "tenantId", "code", "name", "establishmentCode",
                        "seriesNumber", "address", "phone", "isDefault", "isActive")
SELECT
  gen_random_uuid()::text,
  t."id",
  'PRINCIPAL',
  'Casa matriz',
  '0000',          -- código SUNAT de la casa matriz
  1,               -- de aquí sale la serie "001" que ya está en uso
  t."address",
  t."phone",
  true,
  true
FROM "tenants" t;

-- ── Almacenes: ahora pertenecen a una sucursal ─────────────────────────────
ALTER TABLE "warehouses" ADD COLUMN "branchId" TEXT;

UPDATE "warehouses" w
   SET "branchId" = b."id"
  FROM "branches" b
 WHERE b."tenantId" = w."tenantId" AND b."isDefault" = true;

ALTER TABLE "warehouses" ALTER COLUMN "branchId" SET NOT NULL;

ALTER TABLE "warehouses"
  ADD CONSTRAINT "warehouses_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId")
    REFERENCES "branches" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

CREATE INDEX "warehouses_tenantId_branchId_isActive_idx"
  ON "warehouses" ("tenantId", "branchId", "isActive");

-- ── Contadores: la serie pasa a pertenecer a una sucursal ──────────────────
-- Ojo: el único (tenantId, scope, series) NO se toca. Ese índice es lo que
-- garantiza que una serie sea de UNA sola sucursal, y por eso la lógica de
-- numeración sin huecos sigue buscando por serie y no cambió de firma.
ALTER TABLE "document_counters" ADD COLUMN "branchId" TEXT;

UPDATE "document_counters" c
   SET "branchId" = b."id"
  FROM "branches" b
 WHERE b."tenantId" = c."tenantId" AND b."isDefault" = true;

ALTER TABLE "document_counters" ALTER COLUMN "branchId" SET NOT NULL;

ALTER TABLE "document_counters"
  ADD CONSTRAINT "document_counters_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId")
    REFERENCES "branches" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

CREATE INDEX "document_counters_tenantId_branchId_scope_idx"
  ON "document_counters" ("tenantId", "branchId", "scope");

-- ── Usuarios asignados a sucursales ────────────────────────────────────────
CREATE TABLE "user_branches" (
  "tenantId"  TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "branchId"  TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_branches_pkey" PRIMARY KEY ("tenantId", "userId", "branchId")
);

CREATE INDEX "user_branches_tenantId_branchId_idx" ON "user_branches" ("tenantId", "branchId");

ALTER TABLE "user_branches"
  ADD CONSTRAINT "user_branches_tenantId_fkey" FOREIGN KEY ("tenantId")
    REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "user_branches_tenantId_userId_fkey" FOREIGN KEY ("tenantId", "userId")
    REFERENCES "users" ("tenantId", "id") ON DELETE CASCADE ON UPDATE NO ACTION,
  ADD CONSTRAINT "user_branches_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId")
    REFERENCES "branches" ("tenantId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- BACKFILL: todo usuario con tenant entra a la casa matriz. Sin esto, al
-- desplegar nadie podría operar: todos quedarían sin sucursal asignada.
INSERT INTO "user_branches" ("tenantId", "userId", "branchId")
SELECT u."tenantId", u."id", b."id"
  FROM "users" u
  JOIN "branches" b ON b."tenantId" = u."tenantId" AND b."isDefault" = true
 WHERE u."tenantId" IS NOT NULL;

-- ── Turnos de caja ─────────────────────────────────────────────────────────
CREATE TABLE "cash_sessions" (
  "id"             TEXT NOT NULL,
  "tenantId"       TEXT NOT NULL,
  "branchId"       TEXT NOT NULL,
  "openedById"     TEXT NOT NULL,
  "closedById"     TEXT,
  "status"         "CashSessionStatus" NOT NULL DEFAULT 'ABIERTA',
  "openingAmount"  DECIMAL(14,2) NOT NULL,
  "countedAmount"  DECIMAL(14,2),
  "expectedAmount" DECIMAL(14,2),
  "difference"     DECIMAL(14,2),
  "salesCount"     INTEGER NOT NULL DEFAULT 0,
  "salesTotal"     DECIMAL(14,2) NOT NULL DEFAULT 0,
  "cashTotal"      DECIMAL(14,2) NOT NULL DEFAULT 0,
  "changeTotal"    DECIMAL(14,2) NOT NULL DEFAULT 0,
  "openingNotes"   TEXT,
  "closingNotes"   TEXT,
  "openedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closedAt"       TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cash_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "cash_sessions_tenantId_id_key" ON "cash_sessions" ("tenantId", "id");
CREATE INDEX "cash_sessions_tenantId_branchId_status_idx"
  ON "cash_sessions" ("tenantId", "branchId", "status");
CREATE INDEX "cash_sessions_tenantId_branchId_openedAt_idx"
  ON "cash_sessions" ("tenantId", "branchId", "openedAt");

-- UNA sola caja abierta por sucursal. Índice PARCIAL porque los turnos
-- cerrados son muchos y no deben colisionar entre sí; Prisma no sabe
-- expresar índices parciales, así que va a mano (igual que stocks_no_variant_key).
-- Sin esto, dos cajeros podrían abrir turno a la vez en el mismo local y el
-- arqueo de ambos saldría cuadrado por separado y descuadrado en conjunto.
CREATE UNIQUE INDEX "cash_sessions_una_abierta_por_sucursal"
  ON "cash_sessions" ("tenantId", "branchId")
  WHERE "status" = 'ABIERTA';

ALTER TABLE "cash_sessions"
  ADD CONSTRAINT "cash_sessions_tenantId_fkey" FOREIGN KEY ("tenantId")
    REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "cash_sessions_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId")
    REFERENCES "branches" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "cash_sessions_openedById_fkey" FOREIGN KEY ("openedById")
    REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "cash_sessions_closedById_fkey" FOREIGN KEY ("closedById")
    REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Ventas y cotizaciones: sucursal emisora ────────────────────────────────
ALTER TABLE "sales"  ADD COLUMN "branchId" TEXT;
ALTER TABLE "sales"  ADD COLUMN "cashSessionId" TEXT;
ALTER TABLE "quotes" ADD COLUMN "branchId" TEXT;

-- Se deduce del almacén, que ya tiene sucursal tras el paso anterior.
UPDATE "sales" s
   SET "branchId" = w."branchId"
  FROM "warehouses" w
 WHERE w."id" = s."warehouseId" AND w."tenantId" = s."tenantId";

UPDATE "quotes" q
   SET "branchId" = w."branchId"
  FROM "warehouses" w
 WHERE w."id" = q."warehouseId" AND w."tenantId" = q."tenantId";

-- Red de seguridad: si alguna venta apuntara a un almacén inexistente, se
-- asigna la casa matriz antes del NOT NULL, para que la migración no aborte
-- a medias y deje la base en un estado peor que el de partida.
UPDATE "sales" s
   SET "branchId" = b."id"
  FROM "branches" b
 WHERE s."branchId" IS NULL AND b."tenantId" = s."tenantId" AND b."isDefault" = true;

UPDATE "quotes" q
   SET "branchId" = b."id"
  FROM "branches" b
 WHERE q."branchId" IS NULL AND b."tenantId" = q."tenantId" AND b."isDefault" = true;

ALTER TABLE "sales"  ALTER COLUMN "branchId" SET NOT NULL;
ALTER TABLE "quotes" ALTER COLUMN "branchId" SET NOT NULL;

ALTER TABLE "sales"
  ADD CONSTRAINT "sales_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId")
    REFERENCES "branches" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "sales_tenantId_cashSessionId_fkey" FOREIGN KEY ("tenantId", "cashSessionId")
    REFERENCES "cash_sessions" ("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "quotes"
  ADD CONSTRAINT "quotes_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId")
    REFERENCES "branches" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

CREATE INDEX "sales_tenantId_branchId_status_createdAt_idx"
  ON "sales" ("tenantId", "branchId", "status", "createdAt");
CREATE INDEX "sales_tenantId_cashSessionId_idx" ON "sales" ("tenantId", "cashSessionId");
CREATE INDEX "quotes_tenantId_branchId_status_createdAt_idx"
  ON "quotes" ("tenantId", "branchId", "status", "createdAt");

-- ── Transferencias entre sucursales ────────────────────────────────────────
CREATE TABLE "branch_transfers" (
  "id"              TEXT NOT NULL,
  "tenantId"        TEXT NOT NULL,
  "number"          TEXT NOT NULL,
  "fromBranchId"    TEXT NOT NULL,
  "fromWarehouseId" TEXT NOT NULL,
  "toBranchId"      TEXT NOT NULL,
  "toWarehouseId"   TEXT NOT NULL,
  "status"          "TransferStatus" NOT NULL DEFAULT 'BORRADOR',
  "requestedById"   TEXT NOT NULL,
  "approvedById"    TEXT,
  "receivedById"    TEXT,
  "requestedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "approvedAt"      TIMESTAMP(3),
  "shippedAt"       TIMESTAMP(3),
  "receivedAt"      TIMESTAMP(3),
  "notes"           TEXT,
  "rejectReason"    TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "branch_transfers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "branch_transfers_tenantId_id_key" ON "branch_transfers" ("tenantId", "id");
CREATE UNIQUE INDEX "branch_transfers_tenantId_number_key" ON "branch_transfers" ("tenantId", "number");
CREATE INDEX "branch_transfers_tenantId_status_requestedAt_idx"
  ON "branch_transfers" ("tenantId", "status", "requestedAt");
CREATE INDEX "branch_transfers_tenantId_fromBranchId_status_idx"
  ON "branch_transfers" ("tenantId", "fromBranchId", "status");
CREATE INDEX "branch_transfers_tenantId_toBranchId_status_idx"
  ON "branch_transfers" ("tenantId", "toBranchId", "status");

ALTER TABLE "branch_transfers"
  ADD CONSTRAINT "branch_transfers_tenantId_fkey" FOREIGN KEY ("tenantId")
    REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "branch_transfers_tenantId_fromBranchId_fkey" FOREIGN KEY ("tenantId", "fromBranchId")
    REFERENCES "branches" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "branch_transfers_tenantId_toBranchId_fkey" FOREIGN KEY ("tenantId", "toBranchId")
    REFERENCES "branches" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "branch_transfers_requestedById_fkey" FOREIGN KEY ("requestedById")
    REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "branch_transfers_approvedById_fkey" FOREIGN KEY ("approvedById")
    REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "branch_transfers_receivedById_fkey" FOREIGN KEY ("receivedById")
    REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "branch_transfer_items" (
  "id"               TEXT NOT NULL,
  "tenantId"         TEXT NOT NULL,
  "transferId"       TEXT NOT NULL,
  "productId"        TEXT NOT NULL,
  "variantId"        TEXT,
  "nameSnapshot"     TEXT NOT NULL,
  "skuSnapshot"      TEXT NOT NULL,
  "unitType"         "UnitType" NOT NULL DEFAULT 'UNIDAD',
  "quantitySent"     DECIMAL(14,4) NOT NULL,
  "quantityReceived" DECIMAL(14,4),
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "branch_transfer_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "branch_transfer_items_tenantId_transferId_idx"
  ON "branch_transfer_items" ("tenantId", "transferId");
CREATE INDEX "branch_transfer_items_tenantId_productId_idx"
  ON "branch_transfer_items" ("tenantId", "productId");

ALTER TABLE "branch_transfer_items"
  ADD CONSTRAINT "branch_transfer_items_tenantId_fkey" FOREIGN KEY ("tenantId")
    REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "branch_transfer_items_tenantId_transferId_fkey" FOREIGN KEY ("tenantId", "transferId")
    REFERENCES "branch_transfers" ("tenantId", "id") ON DELETE CASCADE ON UPDATE NO ACTION,
  ADD CONSTRAINT "branch_transfer_items_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId")
    REFERENCES "products" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "branch_transfer_items_tenantId_variantId_fkey" FOREIGN KEY ("tenantId", "variantId")
    REFERENCES "product_variants" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;
