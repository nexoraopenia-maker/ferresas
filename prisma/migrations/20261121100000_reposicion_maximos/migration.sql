-- F6.6a · Stock mínimo y reposición sugerida: nivel objetivo (máximo) por almacén y por variante (aditiva).
--
-- El umbral se hereda de lo más específico a lo más general: Stock (almacén) → ProductVariant → Product. `Product.maxStock` ya existía (sin uso);
-- aquí nacen las otras dos puntas para que la herencia sea simétrica. Sin tocar ninguna fila existente: las columnas nuevas son nulas (= «hereda»).
--
-- Los CHECK usan `IS NOT NULL` explícito: un CHECK cuyo resultado es NULL APRUEBA, y no queremos que un máximo negativo pase por tener el mínimo vacío.


-- AlterTable
ALTER TABLE "product_variants" ADD COLUMN     "maxStock" DECIMAL(14,4);

-- AlterTable
ALTER TABLE "stocks" ADD COLUMN     "maxStock" DECIMAL(14,4);

-- CheckConstraint: un máximo no es negativo y, si convive con un mínimo de la misma fila, no lo baja.
ALTER TABLE "stocks" ADD CONSTRAINT "stocks_maximo_chk"
  CHECK ("maxStock" IS NULL OR ("maxStock" >= 0 AND ("minStock" IS NULL OR "maxStock" >= "minStock")));
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_maximo_chk"
  CHECK ("maxStock" IS NULL OR ("maxStock" >= 0 AND "maxStock" >= "minStock"));
