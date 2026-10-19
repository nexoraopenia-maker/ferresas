-- ═══════════════════════════════════════════════════════════════════════════
--  ROLES NUEVOS: CAJERO y CONTADOR
-- ═══════════════════════════════════════════════════════════════════════════
--
--  Fase B. La escalera de roles no sabía expresar lo que el negocio necesita:
--
--    · El CONTADOR ve reportes y comprobantes pero no vende ni toca stock.
--      No está «por encima» ni «por debajo» del cajero: está al lado.
--    · El CAJERO cobra; el VENDEDOR arma el pedido y NO cobra. Separarlos es
--      lo que permite el relevo de mostrador sin que el vendedor toque dinero.
--
--  VENDEDOR **no se renombra**: decisión explícita del dueño del producto.
--  Los dos roles se AÑADEN, así que ningún usuario existente cambia de rol ni
--  de permisos por esta migración.
--
--  Nota de Postgres: `ALTER TYPE ... ADD VALUE` puede correr dentro de una
--  transacción desde PG 12, siempre que el valor nuevo no se USE en la misma
--  transacción. Aquí solo se añade, así que no hay problema.
-- ───────────────────────────────────────────────────────────────────────────

ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'CAJERO';
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'CONTADOR';
