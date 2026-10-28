-- F6.3a · Movimientos manuales de caja: ingresos y egresos de EFECTIVO del cajón, siempre dentro del turno abierto donde se registran.
-- ADITIVA (expand): dos tipos, una tabla con sus índices y claves, y dos columnas con valor por defecto en `cash_sessions` (los turnos existentes
-- quedan con 0 ingresos y 0 egresos manuales: su efectivo esperado congelado no cambia). Después se añaden los CHECK.


-- CreateEnum
CREATE TYPE "CashMovementKind" AS ENUM ('INGRESO', 'EGRESO');

-- CreateEnum
CREATE TYPE "CashMovementCategory" AS ENUM ('GASTO_MENOR', 'RETIRO_DUENO', 'REPOSICION_FONDO', 'CORRECCION_ARQUEO', 'OTRO');

-- AlterTable
ALTER TABLE "cash_sessions" ADD COLUMN     "manualInTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "manualOutTotal" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "cash_movements" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "cashSessionId" TEXT NOT NULL,
    "kind" "CashMovementKind" NOT NULL,
    "category" "CashMovementCategory" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "description" TEXT NOT NULL,
    "reference" TEXT,
    "exceededExpected" BOOLEAN NOT NULL DEFAULT false,
    "relatedSessionId" TEXT,
    "relatedPaymentId" TEXT,
    "userId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "voidedAt" TIMESTAMP(3),
    "voidedById" TEXT,
    "voidReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_movements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cash_movements_tenantId_cashSessionId_idx" ON "cash_movements"("tenantId", "cashSessionId");

-- CreateIndex
CREATE INDEX "cash_movements_tenantId_branchId_createdAt_idx" ON "cash_movements"("tenantId", "branchId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "cash_movements_tenantId_id_key" ON "cash_movements"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "cash_movements_tenantId_idempotencyKey_key" ON "cash_movements"("tenantId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "branches"("tenantId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_tenantId_cashSessionId_fkey" FOREIGN KEY ("tenantId", "cashSessionId") REFERENCES "cash_sessions"("tenantId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_tenantId_relatedSessionId_fkey" FOREIGN KEY ("tenantId", "relatedSessionId") REFERENCES "cash_sessions"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_tenantId_relatedPaymentId_fkey" FOREIGN KEY ("tenantId", "relatedPaymentId") REFERENCES "customer_payments"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_voidedById_fkey" FOREIGN KEY ("voidedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── CHECK ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- Un movimiento mueve dinero (monto > 0), se explica (descripción de al menos 3 letras) y tiene una clave de idempotencia no vacía.
-- Cada tipo admite solo sus categorías: un INGRESO no puede ser un gasto menor ni un retiro del dueño.
ALTER TABLE "cash_movements"
  ADD CONSTRAINT "cash_movements_importe_chk" CHECK ("amount" > 0 AND length(btrim("description")) >= 3 AND length(btrim("idempotencyKey")) > 0),
  ADD CONSTRAINT "cash_movements_categoria_chk" CHECK (
        ("kind" = 'INGRESO' AND "category" IN ('REPOSICION_FONDO', 'CORRECCION_ARQUEO', 'OTRO'))
     OR ("kind" = 'EGRESO'  AND "category" IN ('GASTO_MENOR', 'RETIRO_DUENO', 'CORRECCION_ARQUEO', 'OTRO'))
  ),
  -- Anular exige quién, cuándo y por qué (con motivo de al menos 3 letras); sin anular, nada de eso.
  ADD CONSTRAINT "cash_movements_anulacion_chk" CHECK (
        ("voidedAt" IS NULL AND "voidedById" IS NULL AND "voidReason" IS NULL)
     OR ("voidedAt" IS NOT NULL AND "voidedById" IS NOT NULL AND "voidReason" IS NOT NULL AND length(btrim("voidReason")) >= 3)
  ),
  -- Corregir un turno cerrado o un abono apunta a algo distinto de sí mismo: el movimiento no puede corregir SU propio turno.
  ADD CONSTRAINT "cash_movements_correccion_chk" CHECK ("relatedSessionId" IS NULL OR "relatedSessionId" <> "cashSessionId");

-- Los totales congelados del turno nunca son negativos.
ALTER TABLE "cash_sessions"
  ADD CONSTRAINT "cash_sessions_manuales_chk" CHECK ("manualInTotal" >= 0 AND "manualOutTotal" >= 0);
