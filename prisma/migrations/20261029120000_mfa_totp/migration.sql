-- AlterTable
ALTER TABLE "users" ADD COLUMN     "mfaEnabledAt" TIMESTAMP(3),
ADD COLUMN     "mfaFailedAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "mfaLastStep" INTEGER,
ADD COLUMN     "mfaLockedUntil" TIMESTAMP(3),
ADD COLUMN     "mfaRecoveryHashes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "mfaSecretEnc" TEXT;

