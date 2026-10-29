-- Reversa de S3: se pierden los XML firmados y los CDR guardados (no hay otra copia: solo reviértela si aún no se emitió nada real).
DROP TABLE "tax_document_files";
DROP FUNCTION tax_document_files_inmutable();
DROP TYPE "TaxFileKind";
