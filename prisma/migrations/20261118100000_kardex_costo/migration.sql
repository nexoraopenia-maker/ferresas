-- F6.4a · Kardex valorizado: el costo de cada movimiento de stock (aditiva).
--
-- Cada movimiento guarda con qué costo se valoró (`unitCostApplied`) y cuál era el costo promedio del producto justo después (`costAfter`), para que el
-- kardex pueda dar el saldo valorizado en cualquier punto del tiempo sin repetir la historia. `costOrigin` dice de dónde sale el dato: EXACTO (lo escribió
-- el sistema en el momento), RECONSTRUIDO (lo calculó el rellenado histórico) o SIN_DATO (no se sabe: y entonces no hay cifras).
--
-- Las filas existentes quedan SIN_DATO por el valor por defecto (constante: no reescribe la tabla); el script `scripts/rellenar-costo-kardex.ts` las mejora.

-- CreateEnum
CREATE TYPE "MovementCostOrigin" AS ENUM ('EXACTO', 'RECONSTRUIDO', 'SIN_DATO');

-- AlterTable
ALTER TABLE "stock_movements" ADD COLUMN     "costAfter" DECIMAL(12,4),
ADD COLUMN     "costOrigin" "MovementCostOrigin" NOT NULL DEFAULT 'SIN_DATO',
ADD COLUMN     "unitCostApplied" DECIMAL(12,4);

-- Costos nunca negativos.
ALTER TABLE "stock_movements"
  ADD CONSTRAINT "stock_movements_costo_chk" CHECK (
    ("unitCostApplied" IS NULL OR "unitCostApplied" >= 0)
    AND ("costAfter" IS NULL OR "costAfter" >= 0)
  ),
  -- Un dato marcado como conocido siempre trae el promedio; uno SIN_DATO no trae cifras inventadas.
  ADD CONSTRAINT "stock_movements_costo_origen_chk" CHECK (
    ("costOrigin" = 'SIN_DATO' AND "costAfter" IS NULL AND "unitCostApplied" IS NULL)
    OR ("costOrigin" <> 'SIN_DATO' AND "costAfter" IS NOT NULL)
  );
