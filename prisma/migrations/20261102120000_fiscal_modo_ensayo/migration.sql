-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "fiscalAlertCriticalHours" INTEGER,
ADD COLUMN     "fiscalAlertWarnHours" INTEGER,
ADD COLUMN     "realBillingPausedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "tax_documents" ADD COLUMN     "isTrial" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "tax_documents_tenantId_isTrial_status_issuedAt_idx" ON "tax_documents"("tenantId", "isTrial", "status", "issuedAt");

