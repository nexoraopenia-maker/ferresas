-- AlterTable
ALTER TABLE "sales" ADD COLUMN     "idempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "sales_tenantId_idempotencyKey_key" ON "sales"("tenantId", "idempotencyKey");



-- ─── Lo que Prisma no sabe expresar (a mano) ──────────────────────────────────────────────────────────

-- La clave, si existe, no puede estar en blanco (una clave vacía haría chocar entre sí ventas sin relación).
ALTER TABLE "sales"
  ADD CONSTRAINT "sales_clave_chk" CHECK ("idempotencyKey" IS NULL OR length(btrim("idempotencyKey")) > 0);
