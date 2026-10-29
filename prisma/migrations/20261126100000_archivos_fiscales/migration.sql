-- S3 · SUNAT directo: archivos fiscales de cada comprobante (aditiva).
--
-- `tax_document_files` guarda lo que se envió a SUNAT (el XML firmado) y lo que SUNAT respondió (el CDR), comprimido (gzip) y con el hash del contenido SIN comprimir.
-- Es la prueba ante SUNAT: se escribe UNA vez por comprobante y tipo (índice único) y NO se puede modificar (disparador); no hay borrado automático. Solo se borra en cascada
-- si se borra el comprobante o el negocio. Aislada por negocio con clave compuesta al comprobante. Los CHECK exigen un hash válido y un tamaño razonable (≤ 5 MB).
-- No toca ninguna fila existente. `Tenant.pse*` siguen donde están (se retiran en un paso destructivo aparte).

-- CreateEnum
CREATE TYPE "TaxFileKind" AS ENUM ('XML_FIRMADO', 'CDR');
-- CreateTable
CREATE TABLE "tax_document_files" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "taxDocumentId" TEXT NOT NULL,
    "kind" "TaxFileKind" NOT NULL,
    "content" BYTEA NOT NULL,
    "sha256" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tax_document_files_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "tax_document_files_tenantId_taxDocumentId_idx" ON "tax_document_files"("tenantId", "taxDocumentId");
-- CreateIndex
CREATE UNIQUE INDEX "tax_document_files_taxDocumentId_kind_key" ON "tax_document_files"("taxDocumentId", "kind");
-- AddForeignKey
ALTER TABLE "tax_document_files" ADD CONSTRAINT "tax_document_files_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "tax_document_files" ADD CONSTRAINT "tax_document_files_tenantId_taxDocumentId_fkey" FOREIGN KEY ("tenantId", "taxDocumentId") REFERENCES "tax_documents"("tenantId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- CheckConstraints
ALTER TABLE "tax_document_files" ADD CONSTRAINT "tax_document_files_hash_chk" CHECK ("sha256" ~ '^[0-9a-f]{64}$');
ALTER TABLE "tax_document_files" ADD CONSTRAINT "tax_document_files_tamano_chk" CHECK ("size" > 0 AND "size" <= 5242880 AND octet_length("content") > 0);

-- Inmutable: lo que SUNAT recibió y respondió no se corrige después.
CREATE FUNCTION tax_document_files_inmutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Los archivos fiscales de un comprobante no se pueden modificar' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER tax_document_files_no_update BEFORE UPDATE ON "tax_document_files" FOR EACH ROW EXECUTE FUNCTION tax_document_files_inmutable();
