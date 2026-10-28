-- Deshace F6.6a (solo desarrollo y emergencias: borra los máximos por almacén y por variante; el mínimo, el stock y los movimientos no se tocan).
ALTER TABLE "stocks" DROP CONSTRAINT IF EXISTS "stocks_maximo_chk";
ALTER TABLE "product_variants" DROP CONSTRAINT IF EXISTS "product_variants_maximo_chk";
ALTER TABLE "stocks" DROP COLUMN IF EXISTS "maxStock";
ALTER TABLE "product_variants" DROP COLUMN IF EXISTS "maxStock";
