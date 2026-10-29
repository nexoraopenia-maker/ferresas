-- S6 · SUNAT directo: retiro DEFINITIVO del PSE (DESTRUCTIVA, paso 2 de 2 del plan D6).
--
-- Desde S2/S3 ningún código lee ni escribe estas columnas: la URL y el token del intermediario (PSE) ya no existen en la aplicación y las credenciales de SUNAT viven en
-- `sunat_credentials`. Se eliminan:
--   · tenants.pseEndpointUrl   (URL base del PSE)
--   · tenants.pseTokenEnc      (token del PSE cifrado)
--   · tenants.pseConfiguredAt  (cuándo se configuró)
-- Si algún negocio llegó a guardar un token del PSE, SE PIERDE (no hay otra copia). Antes de desplegar: `npx tsx scripts/verificar-pse-sin-datos.ts` (solo lectura) dice si queda algo.
ALTER TABLE "tenants" DROP COLUMN "pseEndpointUrl";
ALTER TABLE "tenants" DROP COLUMN "pseTokenEnc";
ALTER TABLE "tenants" DROP COLUMN "pseConfiguredAt";
