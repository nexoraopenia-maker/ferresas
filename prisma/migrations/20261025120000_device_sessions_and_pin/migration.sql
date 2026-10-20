-- AlterTable
ALTER TABLE "users" ADD COLUMN     "pinFailedAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pinHash" TEXT,
ADD COLUMN     "pinLockedAt" TIMESTAMP(3),
ADD COLUMN     "pinSetAt" TIMESTAMP(3);
-- CreateTable
CREATE TABLE "device_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tenantId" TEXT,
    "userAgent" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    CONSTRAINT "device_sessions_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "device_sessions_userId_revokedAt_idx" ON "device_sessions"("userId", "revokedAt");
-- CreateIndex
CREATE INDEX "device_sessions_tenantId_userId_idx" ON "device_sessions"("tenantId", "userId");
-- AddForeignKey
ALTER TABLE "device_sessions" ADD CONSTRAINT "device_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
