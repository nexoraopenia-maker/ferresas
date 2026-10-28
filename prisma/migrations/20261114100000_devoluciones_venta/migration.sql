-- F6.1 · Anulación y devolución de una venta completa: tablas de devoluciones, reembolsos y columnas de turno.
-- ADITIVA (expand): tipos, tablas e índices nuevos, dos columnas con valor por defecto y un CHECK sobre `sales`.
-- ⚠️ El CHECK de `sales` falla si ya hubiera ventas ANULADA/DEVUELTA sin fecha o motivo: correr antes
--    `npx tsx scripts/verificar-ventas-anuladas.ts` (solo lectura) con el entorno de producción.

-- CreateEnum
CREATE TYPE "SaleReturnKind" AS ENUM ('ANULACION', 'DEVOLUCION');

-- CreateEnum
CREATE TYPE "RefundMode" AS ENUM ('CAJA', 'EXTERNO', 'SIN_SALIDA');

-- AlterTable
ALTER TABLE "cash_sessions" ADD COLUMN     "refundsCashTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "refundsOtherTotal" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "sale_returns" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "kind" "SaleReturnKind" NOT NULL,
    "number" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "isFull" BOOLEAN NOT NULL DEFAULT true,
    "userId" TEXT NOT NULL,
    "creditNoteId" TEXT,
    "saleTotal" DECIMAL(14,2) NOT NULL,
    "paidNet" DECIMAL(14,2) NOT NULL,
    "receivableVoidedAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sale_returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_return_items" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "returnId" TEXT NOT NULL,
    "saleItemId" TEXT NOT NULL,
    "quantity" DECIMAL(14,4) NOT NULL,
    "enteredQuantity" DECIMAL(14,4),
    "presentationName" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "sale_return_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_return_refunds" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "returnId" TEXT NOT NULL,
    "mode" "RefundMode" NOT NULL,
    "method" "PaymentMethod",
    "amount" DECIMAL(14,2) NOT NULL,
    "reference" TEXT,
    "cashSessionId" TEXT,

    CONSTRAINT "sale_return_refunds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sale_returns_tenantId_saleId_idx" ON "sale_returns"("tenantId", "saleId");

-- CreateIndex
CREATE INDEX "sale_returns_tenantId_createdAt_idx" ON "sale_returns"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "sale_returns_tenantId_id_key" ON "sale_returns"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sale_returns_tenantId_number_key" ON "sale_returns"("tenantId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "sale_returns_tenantId_idempotencyKey_key" ON "sale_returns"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "sale_return_items_tenantId_saleItemId_idx" ON "sale_return_items"("tenantId", "saleItemId");

-- CreateIndex
CREATE UNIQUE INDEX "sale_return_items_tenantId_returnId_saleItemId_key" ON "sale_return_items"("tenantId", "returnId", "saleItemId");

-- CreateIndex
CREATE INDEX "sale_return_refunds_tenantId_returnId_idx" ON "sale_return_refunds"("tenantId", "returnId");

-- CreateIndex
CREATE INDEX "sale_return_refunds_tenantId_cashSessionId_idx" ON "sale_return_refunds"("tenantId", "cashSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "sale_items_tenantId_id_key" ON "sale_items"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "sale_returns" ADD CONSTRAINT "sale_returns_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_returns" ADD CONSTRAINT "sale_returns_tenantId_saleId_fkey" FOREIGN KEY ("tenantId", "saleId") REFERENCES "sales"("tenantId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "sale_returns" ADD CONSTRAINT "sale_returns_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_returns" ADD CONSTRAINT "sale_returns_tenantId_creditNoteId_fkey" FOREIGN KEY ("tenantId", "creditNoteId") REFERENCES "tax_documents"("tenantId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "sale_return_items" ADD CONSTRAINT "sale_return_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_return_items" ADD CONSTRAINT "sale_return_items_tenantId_returnId_fkey" FOREIGN KEY ("tenantId", "returnId") REFERENCES "sale_returns"("tenantId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "sale_return_items" ADD CONSTRAINT "sale_return_items_tenantId_saleItemId_fkey" FOREIGN KEY ("tenantId", "saleItemId") REFERENCES "sale_items"("tenantId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "sale_return_refunds" ADD CONSTRAINT "sale_return_refunds_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_return_refunds" ADD CONSTRAINT "sale_return_refunds_tenantId_returnId_fkey" FOREIGN KEY ("tenantId", "returnId") REFERENCES "sale_returns"("tenantId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "sale_return_refunds" ADD CONSTRAINT "sale_return_refunds_tenantId_cashSessionId_fkey" FOREIGN KEY ("tenantId", "cashSessionId") REFERENCES "cash_sessions"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;


-- ─── Reglas que Prisma no sabe expresar ───────────────────────────────────────────────────────────────────────────────────────────
-- Una sola devolución COMPLETA por venta (las parciales de F6.2 no usan `isFull`).
CREATE UNIQUE INDEX "sale_returns_una_completa_por_venta" ON "sale_returns"("tenantId", "saleId") WHERE "isFull";

ALTER TABLE "sale_returns" ADD CONSTRAINT "sale_returns_importes_chk" CHECK (
  "saleTotal" >= 0 AND "paidNet" >= 0 AND "receivableVoidedAmount" >= 0 AND "paidNet" <= "saleTotal"
  AND "receivableVoidedAmount" <= "saleTotal" AND length(btrim("reason")) >= 3 AND length(btrim("number")) > 0
);

ALTER TABLE "sale_return_items" ADD CONSTRAINT "sale_return_items_importes_chk" CHECK ("quantity" > 0 AND "amount" >= 0);

-- Cada modo de reembolso tiene su forma: CAJA = efectivo desde un turno (obligatorio); EXTERNO = otro medio (ni efectivo ni crédito);
-- SIN_SALIDA = sin medio. En EXTERNO y SIN_SALIDA el turno es opcional: si había uno abierto se anota, solo para el informe del cierre.
ALTER TABLE "sale_return_refunds" ADD CONSTRAINT "sale_return_refunds_forma_chk" CHECK (
  "amount" > 0 AND (
        ("mode" = 'CAJA'       AND "method" = 'EFECTIVO' AND "cashSessionId" IS NOT NULL)
     OR ("mode" = 'EXTERNO'    AND "method" IS NOT NULL AND "method" NOT IN ('EFECTIVO', 'CREDITO'))
     OR ("mode" = 'SIN_SALIDA' AND "method" IS NULL)
  )
);

ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_reembolsos_chk" CHECK ("refundsCashTotal" >= 0 AND "refundsOtherTotal" >= 0);

-- Una venta anulada o devuelta dice cuándo y por qué.
ALTER TABLE "sales" ADD CONSTRAINT "sales_anulada_devuelta_chk" CHECK (
  "status" NOT IN ('ANULADA', 'DEVUELTA') OR ("voidedAt" IS NOT NULL AND "voidReason" IS NOT NULL AND length(btrim("voidReason")) > 0)
);
