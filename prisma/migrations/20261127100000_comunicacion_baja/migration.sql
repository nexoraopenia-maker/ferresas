-- S4 · SUNAT directo: comunicación de baja (aditiva).
--
-- `tax_voids` es la solicitud de baja de un comprobante ya aceptado (RA-AAAAMMDD-N), con su propia cola (intentos y lease) y el ticket de SUNAT. `tax_void_files` guarda lo que se
-- envió (XML firmado) y la constancia (CDR del ticket) con las MISMAS garantías que `tax_document_files`: una vez por tipo, comprimido, con hash, inmutable, sin borrado automático.
-- No toca ninguna fila existente. Como mucho hay UNA solicitud viva (pendiente, enviada o aceptada) por comprobante; una rechazada o agotada se puede volver a pedir.


-- CreateEnum
CREATE TYPE "TaxVoidStatus" AS ENUM ('PENDIENTE', 'ENVIADA', 'ACEPTADA', 'RECHAZADA', 'AGOTADA');

-- CreateTable
CREATE TABLE "tax_voids" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "taxDocumentId" TEXT NOT NULL,
    "issueDay" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "identifier" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "TaxVoidStatus" NOT NULL DEFAULT 'PENDIENTE',
    "requestedBy" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ticket" TEXT,
    "responseCode" TEXT,
    "responseMessage" TEXT,
    "sentAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedUntil" TIMESTAMP(3),
    "lockedBy" TEXT,
    "lastAttemptAt" TIMESTAMP(3),
    "lastError" TEXT,
    "exhaustedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tax_voids_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_void_files" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "taxVoidId" TEXT NOT NULL,
    "kind" "TaxFileKind" NOT NULL,
    "content" BYTEA NOT NULL,
    "sha256" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tax_void_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tax_voids_tenantId_taxDocumentId_idx" ON "tax_voids"("tenantId", "taxDocumentId");

-- CreateIndex
CREATE INDEX "tax_voids_status_nextAttemptAt_idx" ON "tax_voids"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "tax_voids_tenantId_identifier_key" ON "tax_voids"("tenantId", "identifier");

-- CreateIndex
CREATE UNIQUE INDEX "tax_voids_tenantId_id_key" ON "tax_voids"("tenantId", "id");

-- CreateIndex
CREATE INDEX "tax_void_files_tenantId_taxVoidId_idx" ON "tax_void_files"("tenantId", "taxVoidId");

-- CreateIndex
CREATE UNIQUE INDEX "tax_void_files_taxVoidId_kind_key" ON "tax_void_files"("taxVoidId", "kind");

-- AddForeignKey
ALTER TABLE "tax_voids" ADD CONSTRAINT "tax_voids_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_voids" ADD CONSTRAINT "tax_voids_tenantId_taxDocumentId_fkey" FOREIGN KEY ("tenantId", "taxDocumentId") REFERENCES "tax_documents"("tenantId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tax_void_files" ADD CONSTRAINT "tax_void_files_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_void_files" ADD CONSTRAINT "tax_void_files_tenantId_taxVoidId_fkey" FOREIGN KEY ("tenantId", "taxVoidId") REFERENCES "tax_voids"("tenantId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;


-- CheckConstraints
ALTER TABLE "tax_voids" ADD CONSTRAINT "tax_voids_dia_chk" CHECK ("issueDay" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND "seq" > 0);
ALTER TABLE "tax_voids" ADD CONSTRAINT "tax_voids_motivo_chk" CHECK (char_length(btrim("reason")) BETWEEN 1 AND 100);
ALTER TABLE "tax_voids" ADD CONSTRAINT "tax_voids_intentos_chk" CHECK ("attempts" >= 0);
ALTER TABLE "tax_void_files" ADD CONSTRAINT "tax_void_files_hash_chk" CHECK ("sha256" ~ '^[0-9a-f]{64}$');
ALTER TABLE "tax_void_files" ADD CONSTRAINT "tax_void_files_tamano_chk" CHECK ("size" > 0 AND "size" <= 5242880 AND octet_length("content") > 0);

-- Una sola solicitud viva por comprobante.
CREATE UNIQUE INDEX "tax_voids_una_viva_key" ON "tax_voids"("tenantId", "taxDocumentId") WHERE "status" IN ('PENDIENTE', 'ENVIADA', 'ACEPTADA');

-- Inmutable: lo que SUNAT recibió y respondió no se corrige después.
CREATE FUNCTION tax_void_files_inmutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Los archivos de una comunicación de baja no se pueden modificar' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER tax_void_files_no_update BEFORE UPDATE ON "tax_void_files" FOR EACH ROW EXECUTE FUNCTION tax_void_files_inmutable();
