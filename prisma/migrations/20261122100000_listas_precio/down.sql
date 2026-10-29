-- Deshace F6.7a (solo desarrollo y emergencias: BORRA las listas de precio, sus precios y tramos y la lista por defecto de los clientes; las ventas y cotizaciones conservan su precio, solo pierden la trazabilidad de la lista).
DROP INDEX IF EXISTS "customers_tenantId_priceListId_idx";
DROP INDEX IF EXISTS "price_tiers_base_uniq";
DROP INDEX IF EXISTS "price_lists_name_uniq";
ALTER TABLE "sale_items" DROP CONSTRAINT IF EXISTS "sale_items_fuente_precio_chk";
ALTER TABLE "price_tiers" DROP CONSTRAINT IF EXISTS "price_tiers_cantidad_chk", DROP CONSTRAINT IF EXISTS "price_tiers_precio_chk";
ALTER TABLE "price_list_entries" DROP CONSTRAINT IF EXISTS "price_list_entries_precio_chk";
ALTER TABLE "price_lists" DROP CONSTRAINT IF EXISTS "price_lists_nombre_chk", DROP CONSTRAINT IF EXISTS "price_lists_codigo_chk";
ALTER TABLE "customers" DROP CONSTRAINT IF EXISTS "customers_tenantId_priceListId_fkey";
ALTER TABLE "sales" DROP CONSTRAINT IF EXISTS "sales_tenantId_priceListId_fkey";
ALTER TABLE "quotes" DROP CONSTRAINT IF EXISTS "quotes_tenantId_priceListId_fkey";
DROP TABLE IF EXISTS "price_tiers";
DROP TABLE IF EXISTS "price_list_entries";
DROP TABLE IF EXISTS "price_lists";
ALTER TABLE "customers" DROP COLUMN IF EXISTS "priceListId";
ALTER TABLE "sales" DROP COLUMN IF EXISTS "priceListId";
ALTER TABLE "quotes" DROP COLUMN IF EXISTS "priceListId";
ALTER TABLE "sale_items" DROP COLUMN IF EXISTS "priceSource", DROP COLUMN IF EXISTS "tierMinQuantity";
DROP TYPE IF EXISTS "PriceSource";
