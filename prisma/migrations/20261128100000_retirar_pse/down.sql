-- Reversa de S6: devuelve las tres columnas, VACÍAS. Los datos que tuvieran NO se recuperan (la migración los eliminó); la aplicación actual tampoco las usa.
ALTER TABLE "tenants" ADD COLUMN "pseEndpointUrl" TEXT;
ALTER TABLE "tenants" ADD COLUMN "pseTokenEnc" TEXT;
ALTER TABLE "tenants" ADD COLUMN "pseConfiguredAt" TIMESTAMP(3);
