-- CreateEnum
CREATE TYPE "FiscalDispatchStatus" AS ENUM ('PENDIENTE', 'EN_CURSO', 'COMPLETADO', 'AGOTADO');

-- CreateEnum
CREATE TYPE "FiscalDispatchOp" AS ENUM ('ENVIAR', 'CONSULTAR');

-- CreateTable
CREATE TABLE "fiscal_dispatches" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "taxDocumentId" TEXT NOT NULL,
    "op" "FiscalDispatchOp" NOT NULL DEFAULT 'ENVIAR',
    "status" "FiscalDispatchStatus" NOT NULL DEFAULT 'PENDIENTE',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedUntil" TIMESTAMP(3),
    "lockedBy" TEXT,
    "lastAttemptAt" TIMESTAMP(3),
    "lastError" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3),
    "exhaustedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fiscal_dispatches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fiscal_dispatches_status_nextAttemptAt_idx" ON "fiscal_dispatches"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "fiscal_dispatches_status_lockedUntil_idx" ON "fiscal_dispatches"("status", "lockedUntil");

-- CreateIndex
CREATE INDEX "fiscal_dispatches_tenantId_status_idx" ON "fiscal_dispatches"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "fiscal_dispatches_tenantId_taxDocumentId_key" ON "fiscal_dispatches"("tenantId", "taxDocumentId");

-- CreateIndex
CREATE UNIQUE INDEX "fiscal_dispatches_idempotencyKey_key" ON "fiscal_dispatches"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "tax_documents_tenantId_id_key" ON "tax_documents"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "fiscal_dispatches" ADD CONSTRAINT "fiscal_dispatches_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fiscal_dispatches" ADD CONSTRAINT "fiscal_dispatches_tenantId_taxDocumentId_fkey" FOREIGN KEY ("tenantId", "taxDocumentId") REFERENCES "tax_documents"("tenantId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

