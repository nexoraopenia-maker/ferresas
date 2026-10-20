-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "demoSeededAt" TIMESTAMP(3),
ADD COLUMN     "isDemo" BOOLEAN NOT NULL DEFAULT false;
