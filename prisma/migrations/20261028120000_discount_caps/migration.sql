-- CreateTable
CREATE TABLE "discount_caps" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "maxPercent" DECIMAL(5,2) NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "discount_caps_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "discount_caps_tenantId_role_key" ON "discount_caps"("tenantId", "role");
-- AddForeignKey
ALTER TABLE "discount_caps" ADD CONSTRAINT "discount_caps_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
