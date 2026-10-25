-- CreateEnum
CREATE TYPE "ReceivableStatus" AS ENUM ('ABIERTA', 'PAGADA', 'ANULADA');

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "creditBalance" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "creditBlockedAt" TIMESTAMP(3),
ADD COLUMN     "creditTermDays" INTEGER NOT NULL DEFAULT 30;

-- CreateTable
CREATE TABLE "receivables" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "paidAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "dueDate" DATE NOT NULL,
    "status" "ReceivableStatus" NOT NULL DEFAULT 'ABIERTA',
    "closedAt" TIMESTAMP(3),
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "reviewRequestedAt" TIMESTAMP(3),
    "reviewReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "receivables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_payments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "cashSessionId" TEXT,
    "userId" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "reference" TEXT,
    "notes" TEXT,
    "idempotencyKey" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" TIMESTAMP(3),
    "voidedById" TEXT,
    "voidReason" TEXT,

    CONSTRAINT "customer_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_allocations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerPaymentId" TEXT NOT NULL,
    "receivableId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "receivables_tenantId_customerId_status_idx" ON "receivables"("tenantId", "customerId", "status");

-- CreateIndex
CREATE INDEX "receivables_tenantId_status_dueDate_idx" ON "receivables"("tenantId", "status", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "receivables_tenantId_id_key" ON "receivables"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "receivables_tenantId_saleId_key" ON "receivables"("tenantId", "saleId");

-- CreateIndex
CREATE INDEX "customer_payments_tenantId_customerId_receivedAt_idx" ON "customer_payments"("tenantId", "customerId", "receivedAt");

-- CreateIndex
CREATE INDEX "customer_payments_tenantId_cashSessionId_idx" ON "customer_payments"("tenantId", "cashSessionId");

-- CreateIndex
CREATE INDEX "customer_payments_tenantId_branchId_receivedAt_idx" ON "customer_payments"("tenantId", "branchId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "customer_payments_tenantId_id_key" ON "customer_payments"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_payments_tenantId_idempotencyKey_key" ON "customer_payments"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "payment_allocations_tenantId_receivableId_idx" ON "payment_allocations"("tenantId", "receivableId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_allocations_tenantId_id_key" ON "payment_allocations"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_allocations_tenantId_customerPaymentId_receivableId_key" ON "payment_allocations"("tenantId", "customerPaymentId", "receivableId");

-- AddForeignKey
ALTER TABLE "receivables" ADD CONSTRAINT "receivables_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receivables" ADD CONSTRAINT "receivables_tenantId_customerId_fkey" FOREIGN KEY ("tenantId", "customerId") REFERENCES "customers"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "receivables" ADD CONSTRAINT "receivables_tenantId_saleId_fkey" FOREIGN KEY ("tenantId", "saleId") REFERENCES "sales"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_tenantId_customerId_fkey" FOREIGN KEY ("tenantId", "customerId") REFERENCES "customers"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "branches"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_tenantId_cashSessionId_fkey" FOREIGN KEY ("tenantId", "cashSessionId") REFERENCES "cash_sessions"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_voidedById_fkey" FOREIGN KEY ("voidedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_tenantId_customerPaymentId_fkey" FOREIGN KEY ("tenantId", "customerPaymentId") REFERENCES "customer_payments"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_tenantId_receivableId_fkey" FOREIGN KEY ("tenantId", "receivableId") REFERENCES "receivables"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;



-- ─── Lo que Prisma no sabe expresar (a mano) ──────────────────────────────────────────────────────────
-- Son la última línea de defensa: aunque un bug del servicio intentara escribir algo incoherente, la base lo rechaza.
-- Ojo con NULL: un CHECK que da NULL se da por cumplido, así que lo que no puede faltar se pide con IS NOT NULL (length(NULL) > 0 es NULL).

-- Cliente: línea, saldo y plazo con valores sanos. Un cliente con deuda viva no puede darse de baja (borrado lógico).
ALTER TABLE "customers"
  ADD CONSTRAINT "customers_credito_chk" CHECK ("creditLimit" >= 0 AND "creditBalance" >= 0 AND "creditTermDays" BETWEEN 0 AND 365),
  ADD CONSTRAINT "customers_deuda_borrado_chk" CHECK ("deletedAt" IS NULL OR "creditBalance" = 0);

-- Cuenta por cobrar: 0 ≤ abonado ≤ monto, y el estado dice la verdad.
--   ABIERTA: con saldo, sin cerrar ni anular · PAGADA: abonada por completo y cerrada · ANULADA: cerrada, con fecha y motivo.
ALTER TABLE "receivables"
  ADD CONSTRAINT "receivables_montos_chk" CHECK ("amount" > 0 AND "paidAmount" >= 0 AND "paidAmount" <= "amount"),
  ADD CONSTRAINT "receivables_estado_chk" CHECK (
        ("status" = 'ABIERTA' AND "paidAmount" < "amount" AND "closedAt" IS NULL AND "voidedAt" IS NULL AND "voidReason" IS NULL)
     OR ("status" = 'PAGADA'  AND "paidAmount" = "amount" AND "closedAt" IS NOT NULL AND "voidedAt" IS NULL AND "voidReason" IS NULL)
     OR ("status" = 'ANULADA' AND "closedAt" IS NOT NULL AND "voidedAt" IS NOT NULL AND "voidReason" IS NOT NULL AND length(btrim("voidReason")) > 0)
  ),
  ADD CONSTRAINT "receivables_revision_chk" CHECK (("reviewRequestedAt" IS NULL) = ("reviewReason" IS NULL) AND ("reviewReason" IS NULL OR length(btrim("reviewReason")) > 0));

-- Abono: monto positivo, nunca «a crédito», el efectivo entra siempre a un turno de caja, y anular exige quién, cuándo y por qué.
ALTER TABLE "customer_payments"
  ADD CONSTRAINT "customer_payments_monto_chk" CHECK ("amount" > 0),
  ADD CONSTRAINT "customer_payments_metodo_chk" CHECK ("method" <> 'CREDITO'),
  ADD CONSTRAINT "customer_payments_efectivo_caja_chk" CHECK ("method" <> 'EFECTIVO' OR "cashSessionId" IS NOT NULL),
  ADD CONSTRAINT "customer_payments_anulacion_chk" CHECK (
        ("voidedAt" IS NULL AND "voidedById" IS NULL AND "voidReason" IS NULL)
     OR ("voidedAt" IS NOT NULL AND "voidedById" IS NOT NULL AND "voidReason" IS NOT NULL AND length(btrim("voidReason")) > 0)
  ),
  ADD CONSTRAINT "customer_payments_clave_chk" CHECK ("idempotencyKey" IS NULL OR length(btrim("idempotencyKey")) > 0);

-- Reparto de un abono: monto positivo.
ALTER TABLE "payment_allocations"
  ADD CONSTRAINT "payment_allocations_monto_chk" CHECK ("amount" > 0);
