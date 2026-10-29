-- Reversa de S4: se pierden las solicitudes de baja y sus XML y CDR (no hay otra copia: solo reviértela si aún no se dio de baja nada real).
DROP TABLE "tax_void_files";
DROP TABLE "tax_voids";
DROP FUNCTION tax_void_files_inmutable();
DROP TYPE "TaxVoidStatus";
