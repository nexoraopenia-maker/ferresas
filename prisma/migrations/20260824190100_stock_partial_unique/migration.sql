-- PostgreSQL trata cada NULL como distinto, así que el @@unique de Prisma
-- sobre (tenantId, warehouseId, productId, variantId) NO impide dos filas de
-- stock para el mismo producto SIN variante. Prisma no sabe expresar índices
-- parciales, así que va a mano.
CREATE UNIQUE INDEX "stocks_no_variant_key"
  ON "stocks" ("tenantId", "warehouseId", "productId")
  WHERE "variantId" IS NULL;

-- Mismo problema con el correlativo por defecto y el barcode nulo: aquí NO
-- hace falta índice parcial (varios productos pueden no tener código de
-- barras), pero sí conviene acelerar la búsqueda del escáner (§5.1).
CREATE INDEX "products_barcode_lookup"
  ON "products" ("tenantId", "barcode")
  WHERE "barcode" IS NOT NULL AND "deletedAt" IS NULL;
