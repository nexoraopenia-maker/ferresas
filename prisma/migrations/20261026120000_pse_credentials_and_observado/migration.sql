-- AlterEnum
ALTER TYPE "TaxDocumentStatus" ADD VALUE 'OBSERVADO';
-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "pseConfiguredAt" TIMESTAMP(3),
ADD COLUMN     "pseEndpointUrl" TEXT,
ADD COLUMN     "pseTokenEnc" TEXT;
