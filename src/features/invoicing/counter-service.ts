import { BusinessError } from '@/lib/errors'
import { type TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { serieDeSucursal, type CounterScope } from '@/features/branches/series'
import { puede } from '@/lib/puede'
import { ensureCounter } from '@/features/pos/sale-service'

/**
 * Correlativo inicial por serie.
 *
 * ─── EL PROBLEMA ─────────────────────────────────────────────────────────
 *
 * Un negocio que YA facturaba con otro sistema llega con su serie avanzada:
 * B001 en el 4 532. Si FerreSaaS arranca en 1, emitirá números **ya usados**
 * bajo su RUC. Eso no es un dato mal puesto: son comprobantes duplicados
 * ante SUNAT, que solo se arreglan con notas de crédito.
 *
 * ─── POR QUÉ SOLO SE PUEDE TOCAR UNA VEZ ─────────────────────────────────
 *
 * En cuanto esta serie emite su primer comprobante, mover el arranque
 * produciría un HUECO (si se sube) o un DUPLICADO (si se baja). Ninguna de
 * las dos se puede deshacer: el comprobante ya salió impreso y declarado.
 *
 * De ahí que la regla sea `next === startNumber` — nada emitido todavía — y
 * no «solo los administradores» ni «con confirmación». El permiso y la
 * confirmación también están, pero no son lo que protege el invariante.
 *
 * ─── LO QUE NO CAMBIA ────────────────────────────────────────────────────
 *
 * `claimNextNumber` sigue intacto. Esto solo mueve el punto de partida del
 * contador; la numeración sin huecos la sigue garantizando el mismo
 * `UPDATE ... RETURNING` dentro de la transacción. `tests/correlativo.ts`
 * comprueba la concurrencia con un arranque distinto de 1 justamente para
 * verificar que no se rompió.
 */

export interface SerieConfigurable {
  scope: CounterScope
  series: string
  prefix: string
  /** Próximo número que se emitiría. */
  next: number
  /** Número con el que arrancó la serie en este sistema. */
  startNumber: number
  /** Cuántos se emitieron ya desde aquí. */
  emitidos: number
  /**
   * `false` en cuanto se emitió el primero. Mover el arranque después
   * produciría un hueco o un duplicado irreversible.
   */
  editable: boolean
  /** Último correlativo que consta en TaxDocument para esta serie. */
  ultimoEmitido: number | null
}

/** Scopes cuyo arranque tiene sentido configurar: los que van a SUNAT. */
const SCOPES_FISCALES: CounterScope[] = ['TAX_BOLETA', 'TAX_FACTURA']

/**
 * Series fiscales de una sucursal, con su estado de edición.
 *
 * Crea los contadores si no existen: sin eso, el dueño no podría configurar
 * el arranque hasta después de su primera venta, que es exactamente cuando
 * ya no se puede.
 */
export async function listarSeriesConfigurables(
  db: TenantPrismaClient,
  ctx: TenantContext,
  branchId: string,
): Promise<SerieConfigurable[]> {
  const sucursal = await db.branch.findFirst({
    where: { id: branchId, deletedAt: null },
    select: { id: true, seriesNumber: true },
  })
  if (!sucursal) throw new BusinessError('NOT_FOUND', 'La sucursal no existe.')

  const salida: SerieConfigurable[] = []
  for (const scope of SCOPES_FISCALES) {
    const { series, prefix } = serieDeSucursal(scope, sucursal.seriesNumber)
    await ensureCounter(db, ctx.tenantId, branchId, scope, series, prefix)

    const c = await db.documentCounter.findFirstOrThrow({
      where: { scope, series },
      select: { next: true, startNumber: true, prefix: true },
    })

    /*
     * Se consulta TaxDocument además del contador. Son dos fuentes que
     * deberían coincidir, y mirar las dos es deliberado: si por cualquier
     * motivo hubiera comprobantes de una serie cuyo contador se reinició,
     * el contador diría «editable» y estaría mintiendo.
     */
    const agg = await db.taxDocument.aggregate({
      where: {
        documentType: scope === 'TAX_BOLETA' ? 'BOLETA' : 'FACTURA',
        series,
      },
      _max: { correlativo: true },
    })
    const ultimoEmitido = agg._max.correlativo ?? null

    salida.push({
      scope,
      series,
      prefix: c.prefix,
      next: c.next,
      startNumber: c.startNumber,
      emitidos: c.next - c.startNumber,
      editable: c.next === c.startNumber && ultimoEmitido === null,
      ultimoEmitido,
    })
  }
  return salida
}

export interface FijarArranqueInput {
  branchId: string
  scope: CounterScope
  /** Primer número que emitirá esta serie. Para «el último fue 4 532», 4 533. */
  startNumber: number
}

export interface FijarArranqueResultado {
  series: string
  anterior: number
  nuevo: number
}

/**
 * Fija el número con el que arrancará una serie.
 *
 * Solo OWNER o ADMIN: toca la numeración tributaria del negocio.
 */
export async function fijarArranqueSerie(
  db: TenantPrismaClient,
  ctx: TenantContext,
  input: FijarArranqueInput,
): Promise<FijarArranqueResultado> {
  if (!puede(ctx, 'config.fiscal')) {
    throw new BusinessError(
      'FORBIDDEN_ROLE',
      'Solo el dueño puede fijar el correlativo inicial.',
    )
  }
  if (!SCOPES_FISCALES.includes(input.scope)) {
    throw new BusinessError(
      'INVALID_DOCUMENT',
      'Solo se configura el arranque de las series de boleta y factura.',
    )
  }

  return db.$transaction(async (tx) => {
    const t = tx as unknown as TenantPrismaClient

    const sucursal = await t.branch.findFirst({
      where: { id: input.branchId, deletedAt: null },
      select: { id: true, seriesNumber: true, name: true },
    })
    if (!sucursal) throw new BusinessError('NOT_FOUND', 'La sucursal no existe.')

    const { series } = serieDeSucursal(input.scope, sucursal.seriesNumber)

    const c = await t.documentCounter.findFirst({
      where: { scope: input.scope, series },
      select: { id: true, next: true, startNumber: true },
    })
    if (!c) {
      throw new BusinessError(
        'NOT_FOUND',
        'La serie todavía no existe. Abre la pantalla de series para crearla.',
      )
    }

    /*
     * EL INVARIANTE. Se comprueba DENTRO de la transacción: comprobarlo antes
     * dejaría una ventana en la que una venta simultánea emite el primer
     * comprobante entre la lectura y la escritura, y el arranque se movería
     * sobre una serie que ya emitió.
     */
    if (c.next !== c.startNumber) {
      throw new BusinessError(
        'INVALID_DOCUMENT',
        `La serie ${series} ya emitió ${c.next - c.startNumber} ` +
          `${c.next - c.startNumber === 1 ? 'comprobante' : 'comprobantes'}. ` +
          'El correlativo inicial no se puede cambiar después del primero: ' +
          'subirlo dejaría un hueco y bajarlo produciría un número duplicado, ' +
          'y ninguna de las dos cosas se puede deshacer.',
        { series, emitidos: c.next - c.startNumber },
      )
    }

    const agg = await t.taxDocument.aggregate({
      where: {
        documentType: input.scope === 'TAX_BOLETA' ? 'BOLETA' : 'FACTURA',
        series,
      },
      _max: { correlativo: true },
    })
    const ultimo = agg._max.correlativo

    // Segunda fuente: si hay comprobantes de esta serie, el arranque tiene que
    // quedar por encima del último, pase lo que diga el contador.
    if (ultimo != null && input.startNumber <= ultimo) {
      throw new BusinessError(
        'INVALID_DOCUMENT',
        `Ya hay un comprobante ${series}-${String(ultimo).padStart(8, '0')} emitido. ` +
          `El arranque tiene que ser mayor que ${ultimo}.`,
        { series, ultimoEmitido: ultimo },
      )
    }

    if (input.startNumber < c.next) {
      throw new BusinessError(
        'INVALID_DOCUMENT',
        `El arranque no puede quedar por debajo de ${c.next}, que es el próximo ` +
          'número que esta serie emitiría.',
        { series, next: c.next },
      )
    }

    const anterior = c.startNumber
    if (input.startNumber === anterior) {
      return { series, anterior, nuevo: anterior }
    }

    await t.documentCounter.update({
      where: { id: c.id },
      data: { next: input.startNumber, startNumber: input.startNumber },
    })

    await t.auditLog.create({
      data: {
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        actorRole: ctx.role,
        action: 'counter.startNumber',
        entityType: 'DocumentCounter',
        entityId: c.id,
        reason:
          `Correlativo inicial de ${series} fijado en ${input.startNumber} ` +
          `(sucursal ${sucursal.name})`,
        before: { series, startNumber: anterior, next: c.next },
        after: { series, startNumber: input.startNumber, next: input.startNumber },
        impersonationId: ctx.impersonationId ?? null,
      },
    })

    return { series, anterior, nuevo: input.startNumber }
  }, { maxWait: 15_000, timeout: 30_000 })
}
