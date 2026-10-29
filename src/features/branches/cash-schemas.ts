import { z } from 'zod'

const id = z.string().min(1).max(64)

/** Importe de caja: dos decimales, nunca negativo. */
const dinero = z
  .number()
  .finite()
  .min(0, 'El importe no puede ser negativo.')
  .max(9_999_999.99)

export const openCashSchema = z.object({
  /**
   * Fondo de cambio con el que arranca el turno. Obligatorio aunque sea 0:
   * si fuera opcional, el cajero que olvida ponerlo arrancaría con 0 y el
   * arqueo le saldría sobrante por el importe del fondo.
   */
  openingAmount: dinero,
  /** La caja en la que se trabaja (F6.8b). Opcional solo si la sucursal tiene una única caja. */
  registerId: id.optional(),
  notes: z.string().trim().max(300).optional(),
})

export type OpenCashInput = z.infer<typeof openCashSchema>

export const closeCashSchema = z.object({
  sessionId: id,
  /** Efectivo FÍSICO contado por el cajero. El sistema no lo sugiere. */
  countedAmount: dinero,
  notes: z.string().trim().max(500).optional(),
})

export type CloseCashInput = z.infer<typeof closeCashSchema>
