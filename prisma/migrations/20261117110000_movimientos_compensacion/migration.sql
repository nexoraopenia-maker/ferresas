-- F6.3b · (2/2) La compensación de un abono: medio del movimiento y sus reglas.
-- ADITIVA: una columna con valor por defecto EFECTIVO (los movimientos de F6.3a siguen siendo de efectivo) y CHECK nuevos.
-- Anular un abono de un turno CERRADO no toca ese turno: genera un EGRESO de categoría COMPENSACION_ABONO en el turno ABIERTO de hoy, ligado
-- al abono y al turno que corrige. Si el abono fue en efectivo, el egreso sale del cajón de hoy; si fue por otro medio, se registra con ese medio
-- y no mueve el efectivo esperado.

-- AlterTable
ALTER TABLE "cash_movements" ADD COLUMN     "method" "PaymentMethod" NOT NULL DEFAULT 'EFECTIVO';

-- La categoría de cada tipo ahora admite la compensación (solo como EGRESO).
ALTER TABLE "cash_movements" DROP CONSTRAINT "cash_movements_categoria_chk";
ALTER TABLE "cash_movements"
  ADD CONSTRAINT "cash_movements_categoria_chk" CHECK (
        ("kind" = 'INGRESO' AND "category" IN ('REPOSICION_FONDO', 'CORRECCION_ARQUEO', 'OTRO'))
     OR ("kind" = 'EGRESO'  AND "category" IN ('GASTO_MENOR', 'RETIRO_DUENO', 'CORRECCION_ARQUEO', 'OTRO', 'COMPENSACION_ABONO'))
  ),
  -- Una compensación SIEMPRE apunta al abono y al turno cerrado que corrige, y solo ella lo hace (la bijección impide un movimiento a medias).
  ADD CONSTRAINT "cash_movements_compensacion_chk" CHECK (
        ("category" = 'COMPENSACION_ABONO' AND "relatedPaymentId" IS NOT NULL AND "relatedSessionId" IS NOT NULL)
     OR ("category" <> 'COMPENSACION_ABONO' AND "relatedPaymentId" IS NULL)
  ),
  -- El medio: nunca «a crédito», y solo una compensación puede ser de un medio distinto del efectivo (un movimiento manual es dinero del cajón).
  ADD CONSTRAINT "cash_movements_medio_chk" CHECK ("method" <> 'CREDITO' AND ("method" = 'EFECTIVO' OR "category" = 'COMPENSACION_ABONO'));

-- Un abono se anula una sola vez, así que tiene A LO SUMO una compensación. (Índice parcial: Prisma no los declara; lo vigila tests/indices.ts.)
CREATE UNIQUE INDEX "cash_movements_una_compensacion_por_abono" ON "cash_movements"("tenantId", "relatedPaymentId") WHERE "relatedPaymentId" IS NOT NULL;
