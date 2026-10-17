-- ═══════════════════════════════════════════════════════════════════════════
--  CATÁLOGO DE UBIGEO (INEI) + ubigeo del domicilio fiscal
-- ═══════════════════════════════════════════════════════════════════════════
--
--  La tabla nace VACÍA a propósito. Se llena con `scripts/cargar-ubigeo.ts`,
--  que valida el fichero oficial antes de escribir y aborta sin tocar nada si
--  la validación falla. Un catálogo a medias haría imposible seleccionar
--  ciertos distritos, y eso es peor que el campo de texto libre que había.
--
--  Sin `tenantId`: es un catálogo del Estado, idéntico para todos los
--  negocios. Duplicarlo por tenant serían ~2 100 filas por cliente para
--  guardar exactamente lo mismo.
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE "ubigeos" (
  "codigo"    TEXT NOT NULL,
  "nombre"    TEXT NOT NULL,
  "nivel"     INTEGER NOT NULL,
  "padre"     TEXT,
  "version"   TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ubigeos_pkey" PRIMARY KEY ("codigo")
);

CREATE INDEX "ubigeos_nivel_nombre_idx" ON "ubigeos" ("nivel", "nombre");
CREATE INDEX "ubigeos_padre_idx" ON "ubigeos" ("padre");

-- Domicilio fiscal del emisor: va en el XML del comprobante.
ALTER TABLE "tenants" ADD COLUMN "ubigeo" TEXT;
