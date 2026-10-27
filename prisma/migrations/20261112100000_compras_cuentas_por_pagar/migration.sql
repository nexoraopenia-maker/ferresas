-- CreateEnum
CREATE TYPE "PurchaseCondition" AS ENUM ('CONTADO', 'CREDITO');

-- CreateEnum
CREATE TYPE "PayableStatus" AS ENUM ('ABIERTA', 'PAGADA', 'ANULADA');

-- AlterTable
ALTER TABLE "suppliers" ADD COLUMN     "payableBalance" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "paymentTermDays" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "purchases" ADD COLUMN     "dueDate" DATE,
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "paymentCondition" "PurchaseCondition" NOT NULL DEFAULT 'CONTADO',
ADD COLUMN     "receivedById" TEXT,
ADD COLUMN     "voidReason" TEXT,
ADD COLUMN     "voidedAt" TIMESTAMP(3),
ADD COLUMN     "voidedById" TEXT;

-- AlterTable
ALTER TABLE "cash_sessions" ADD COLUMN     "supplierCashPaymentsTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "supplierOtherPaymentsTotal" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "account_payables" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "paidAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "dueDate" DATE NOT NULL,
    "status" "PayableStatus" NOT NULL DEFAULT 'ABIERTA',
    "closedAt" TIMESTAMP(3),
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_payables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_payments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "cashSessionId" TEXT,
    "userId" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "reference" TEXT,
    "notes" TEXT,
    "idempotencyKey" TEXT,
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" TIMESTAMP(3),
    "voidedById" TEXT,
    "voidReason" TEXT,

    CONSTRAINT "supplier_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_payment_allocations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "supplierPaymentId" TEXT NOT NULL,
    "payableId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_payment_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "account_payables_tenantId_supplierId_status_idx" ON "account_payables"("tenantId", "supplierId", "status");

-- CreateIndex
CREATE INDEX "account_payables_tenantId_status_dueDate_idx" ON "account_payables"("tenantId", "status", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "account_payables_tenantId_id_key" ON "account_payables"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "account_payables_tenantId_purchaseId_key" ON "account_payables"("tenantId", "purchaseId");

-- CreateIndex
CREATE INDEX "supplier_payments_tenantId_supplierId_paidAt_idx" ON "supplier_payments"("tenantId", "supplierId", "paidAt");

-- CreateIndex
CREATE INDEX "supplier_payments_tenantId_cashSessionId_idx" ON "supplier_payments"("tenantId", "cashSessionId");

-- CreateIndex
CREATE INDEX "supplier_payments_tenantId_branchId_paidAt_idx" ON "supplier_payments"("tenantId", "branchId", "paidAt");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_payments_tenantId_id_key" ON "supplier_payments"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_payments_tenantId_idempotencyKey_key" ON "supplier_payments"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "supplier_payment_allocations_tenantId_payableId_idx" ON "supplier_payment_allocations"("tenantId", "payableId");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_payment_allocations_tenantId_id_key" ON "supplier_payment_allocations"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_payment_allocations_tenantId_supplierPaymentId_pay_key" ON "supplier_payment_allocations"("tenantId", "supplierPaymentId", "payableId");

-- CreateIndex
CREATE UNIQUE INDEX "purchases_tenantId_idempotencyKey_key" ON "purchases"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "purchases_tenantId_supplierId_invoiceRef_key" ON "purchases"("tenantId", "supplierId", "invoiceRef");

-- AddForeignKey
ALTER TABLE "account_payables" ADD CONSTRAINT "account_payables_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_payables" ADD CONSTRAINT "account_payables_tenantId_supplierId_fkey" FOREIGN KEY ("tenantId", "supplierId") REFERENCES "suppliers"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "account_payables" ADD CONSTRAINT "account_payables_tenantId_purchaseId_fkey" FOREIGN KEY ("tenantId", "purchaseId") REFERENCES "purchases"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_tenantId_supplierId_fkey" FOREIGN KEY ("tenantId", "supplierId") REFERENCES "suppliers"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "branches"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_tenantId_cashSessionId_fkey" FOREIGN KEY ("tenantId", "cashSessionId") REFERENCES "cash_sessions"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_voidedById_fkey" FOREIGN KEY ("voidedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_allocations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_allocations_tenantId_supplierPaymentId_fkey" FOREIGN KEY ("tenantId", "supplierPaymentId") REFERENCES "supplier_payments"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_allocations_tenantId_payableId_fkey" FOREIGN KEY ("tenantId", "payableId") REFERENCES "account_payables"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_receivedById_fkey" FOREIGN KEY ("receivedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_voidedById_fkey" FOREIGN KEY ("voidedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
--  Invariantes que el esquema de Prisma no puede expresar. Aditivo: las tablas de compras no tienen filas que los violen.
--  Trampa del NULL: `length(NULL) > 0` es NULL y un CHECK en NULL PASA; por eso cada length(...) va con `IS NOT NULL AND`.
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

-- Proveedor: deuda y plazo con valores sanos. Un proveedor con deuda viva no puede darse de baja (borrado lógico).
ALTER TABLE "suppliers"
  ADD CONSTRAINT "suppliers_pagar_chk" CHECK ("payableBalance" >= 0 AND "paymentTermDays" BETWEEN 0 AND 365),
  ADD CONSTRAINT "suppliers_deuda_borrado_chk" CHECK ("deletedAt" IS NULL OR "payableBalance" = 0);

-- Compra: importes coherentes, estado que dice la verdad, crédito con vencimiento y proveedor, referencias no vacías.
--   BORRADOR: sin recibir ni anular · RECIBIDA: recibida por alguien, sin anular · ANULADA: anulada por alguien, con fecha y motivo
--   (puede venir de un borrador descartado o de una recibida: por eso `receivedAt` no se exige ni se prohíbe aquí).
ALTER TABLE "purchases"
  ADD CONSTRAINT "purchases_montos_chk" CHECK ("subtotal" >= 0 AND "taxTotal" >= 0 AND "total" >= 0 AND "total" = "subtotal" + "taxTotal"),
  ADD CONSTRAINT "purchases_estado_chk" CHECK (
        ("status" = 'BORRADOR' AND "receivedAt" IS NULL AND "receivedById" IS NULL AND "voidedAt" IS NULL AND "voidedById" IS NULL AND "voidReason" IS NULL)
     OR ("status" = 'RECIBIDA'  AND "receivedAt" IS NOT NULL AND "receivedById" IS NOT NULL AND "voidedAt" IS NULL AND "voidedById" IS NULL AND "voidReason" IS NULL)
     OR ("status" = 'ANULADA'   AND "voidedAt" IS NOT NULL AND "voidedById" IS NOT NULL AND "voidReason" IS NOT NULL AND length(btrim("voidReason")) > 0)
  ),
  ADD CONSTRAINT "purchases_credito_chk" CHECK (
        (("paymentCondition" = 'CREDITO') = ("dueDate" IS NOT NULL))
    AND ("paymentCondition" = 'CONTADO' OR "supplierId" IS NOT NULL)
  ),
  ADD CONSTRAINT "purchases_referencias_chk" CHECK (
        ("idempotencyKey" IS NULL OR length(btrim("idempotencyKey")) > 0)
    AND ("invoiceRef" IS NULL OR length(btrim("invoiceRef")) > 0)
  );

-- Línea de compra: cantidad positiva (es lo que mueve el stock), costo y total no negativos, IGV entre 0 y 100 %.
ALTER TABLE "purchase_items"
  ADD CONSTRAINT "purchase_items_montos_chk" CHECK ("quantity" > 0 AND "unitCost" >= 0 AND "lineTotal" >= 0 AND "taxRate" >= 0 AND "taxRate" <= 1);

-- Cuenta por pagar: 0 ≤ pagado ≤ monto, y el estado dice la verdad.
--   ABIERTA: con saldo, sin cerrar ni anular · PAGADA: pagada por completo y cerrada · ANULADA: cerrada, con fecha y motivo.
ALTER TABLE "account_payables"
  ADD CONSTRAINT "account_payables_montos_chk" CHECK ("amount" > 0 AND "paidAmount" >= 0 AND "paidAmount" <= "amount"),
  ADD CONSTRAINT "account_payables_estado_chk" CHECK (
        ("status" = 'ABIERTA' AND "paidAmount" < "amount" AND "closedAt" IS NULL AND "voidedAt" IS NULL AND "voidReason" IS NULL)
     OR ("status" = 'PAGADA'  AND "paidAmount" = "amount" AND "closedAt" IS NOT NULL AND "voidedAt" IS NULL AND "voidReason" IS NULL)
     OR ("status" = 'ANULADA' AND "closedAt" IS NOT NULL AND "voidedAt" IS NOT NULL AND "voidReason" IS NOT NULL AND length(btrim("voidReason")) > 0)
  );

-- Pago a proveedor: monto positivo, nunca «a crédito», el EFECTIVO sale siempre de un turno de caja, y anular exige quién, cuándo y por qué.
ALTER TABLE "supplier_payments"
  ADD CONSTRAINT "supplier_payments_monto_chk" CHECK ("amount" > 0),
  ADD CONSTRAINT "supplier_payments_metodo_chk" CHECK ("method" <> 'CREDITO'),
  ADD CONSTRAINT "supplier_payments_efectivo_caja_chk" CHECK ("method" <> 'EFECTIVO' OR "cashSessionId" IS NOT NULL),
  ADD CONSTRAINT "supplier_payments_anulacion_chk" CHECK (
        ("voidedAt" IS NULL AND "voidedById" IS NULL AND "voidReason" IS NULL)
     OR ("voidedAt" IS NOT NULL AND "voidedById" IS NOT NULL AND "voidReason" IS NOT NULL AND length(btrim("voidReason")) > 0)
  ),
  ADD CONSTRAINT "supplier_payments_clave_chk" CHECK ("idempotencyKey" IS NULL OR length(btrim("idempotencyKey")) > 0);

-- Reparto de un pago: monto positivo.
ALTER TABLE "supplier_payment_allocations"
  ADD CONSTRAINT "supplier_payment_allocations_monto_chk" CHECK ("amount" > 0);

-- Turno de caja: los totales congelados de pagos a proveedores nunca son negativos.
ALTER TABLE "cash_sessions"
  ADD CONSTRAINT "cash_sessions_proveedores_chk" CHECK ("supplierCashPaymentsTotal" >= 0 AND "supplierOtherPaymentsTotal" >= 0);
