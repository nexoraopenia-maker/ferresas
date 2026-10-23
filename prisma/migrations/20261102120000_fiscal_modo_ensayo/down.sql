-- Receta para DESHACER 20261102120000_fiscal_modo_ensayo. Prisma NO la ejecuta: se corre a mano.
-- Probada en un esquema temporal (deja la base idéntica a la de antes de la migración).
--
-- ⚠️ Qué se pierde al deshacerla:
--   · `tax_documents.isTrial`: después, un documento de prueba solo se reconoce por su serie
--     (empieza por «P»: PB001, PF001). NO volver a habilitar el envío sin revisar esos documentos.
--   · La pausa del envío y los umbrales de alerta de cada negocio.
-- Antes de ejecutarla en un entorno con datos, hacer un respaldo.

DROP INDEX "tax_documents_tenantId_isTrial_status_issuedAt_idx";

ALTER TABLE "tax_documents" DROP COLUMN "isTrial";

ALTER TABLE "tenants"
  DROP COLUMN "fiscalAlertCriticalHours",
  DROP COLUMN "fiscalAlertWarnHours",
  DROP COLUMN "realBillingPausedAt";
