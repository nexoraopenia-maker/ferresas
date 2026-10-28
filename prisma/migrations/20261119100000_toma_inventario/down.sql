-- Deshace F6.5a (solo desarrollo y emergencias: borra los conteos, sus líneas y sus pasadas; el stock y los movimientos no se tocan).
DROP TABLE IF EXISTS "inventory_count_entries";
DROP TABLE IF EXISTS "inventory_count_items";
DROP TABLE IF EXISTS "inventory_counts";
DROP TYPE IF EXISTS "InventoryCountItemStatus";
DROP TYPE IF EXISTS "InventoryCountMode";
DROP TYPE IF EXISTS "InventoryCountScope";
DROP TYPE IF EXISTS "InventoryCountStatus";
