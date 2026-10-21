-- CreateEnum
CREATE TYPE "QuoteKind" AS ENUM ('COTIZACION', 'PEDIDO');
-- AlterTable
ALTER TABLE "quotes" ADD COLUMN     "kind" "QuoteKind" NOT NULL DEFAULT 'COTIZACION',
ADD COLUMN     "lockedAt" TIMESTAMP(3),
ADD COLUMN     "lockedById" TEXT;
-- CreateIndex
CREATE INDEX "quotes_tenantId_branchId_kind_status_createdAt_idx" ON "quotes"("tenantId", "branchId", "kind", "status", "createdAt");
-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_lockedById_fkey" FOREIGN KEY ("lockedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
