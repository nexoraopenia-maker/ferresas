-- S2 · SUNAT directo: credenciales por negocio (aditiva).
--
-- Una fila por negocio con el certificado digital (.pfx) y el usuario SOL SECUNDARIO. El .pfx, su clave y la clave SOL van CIFRADOS
-- (AES-256-GCM atado al negocio, con la versión de la clave maestra dentro del propio texto); aquí solo hay metadatos del certificado.
-- Los CHECK impiden que por error entre un secreto SIN cifrar (el texto cifrado empieza por `v1.` o `v2.`) y que el usuario SOL sea
-- distinto de letras y números. Usan `IS NOT NULL` explícito donde una columna puede ser nula: un CHECK cuyo resultado es NULL APRUEBA.
-- No toca ninguna fila existente. `Tenant.pseEndpointUrl/pseTokenEnc` siguen donde están (se retiran en un paso destructivo aparte).

-- CreateEnum
CREATE TYPE "SunatAmbiente" AS ENUM ('BETA', 'PRODUCCION');
-- CreateTable
CREATE TABLE "sunat_credentials" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "pfxEnc" TEXT NOT NULL,
    "pfxPasswordEnc" TEXT NOT NULL,
    "solUser" TEXT NOT NULL,
    "solPasswordEnc" TEXT NOT NULL,
    "ambiente" "SunatAmbiente" NOT NULL DEFAULT 'BETA',
    "certSubject" TEXT NOT NULL,
    "certIssuer" TEXT NOT NULL,
    "certSerial" TEXT NOT NULL,
    "certRuc" TEXT,
    "certValidFrom" TIMESTAMP(3) NOT NULL,
    "certValidTo" TIMESTAMP(3) NOT NULL,
    "lastTestAt" TIMESTAMP(3),
    "lastTestOk" BOOLEAN,
    "lastTestMessage" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "sunat_credentials_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "sunat_credentials_tenantId_key" ON "sunat_credentials"("tenantId");
-- CreateIndex
CREATE INDEX "sunat_credentials_certValidTo_idx" ON "sunat_credentials"("certValidTo");
-- AddForeignKey
ALTER TABLE "sunat_credentials" ADD CONSTRAINT "sunat_credentials_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CheckConstraints
ALTER TABLE "sunat_credentials" ADD CONSTRAINT "sunat_credentials_cifrado_chk" CHECK ("pfxEnc" ~ '^v[12]\.' AND "pfxPasswordEnc" ~ '^v[12]\.' AND "solPasswordEnc" ~ '^v[12]\.');
ALTER TABLE "sunat_credentials" ADD CONSTRAINT "sunat_credentials_sol_chk" CHECK ("solUser" ~ '^[A-Za-z0-9]{3,30}$');
ALTER TABLE "sunat_credentials" ADD CONSTRAINT "sunat_credentials_vigencia_chk" CHECK ("certValidTo" > "certValidFrom");
ALTER TABLE "sunat_credentials" ADD CONSTRAINT "sunat_credentials_prueba_chk" CHECK (("lastTestAt" IS NULL) = ("lastTestOk" IS NULL));
