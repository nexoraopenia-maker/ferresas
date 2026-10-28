import { cargarPresentaciones, resolverMovimiento, trazaDe } from './presentacion-linea'
import { Prisma } from '@/generated/prisma/client'
import type { MovementSource, MovementType } from '@/generated/prisma/enums'
import { BusinessError } from '@/lib/errors'
import { type TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import type { CreateStockMovementInput } from './schemas'
import { puede } from '@/lib/puede'

/**
 * Lógica de inventario. Vive separada de la Server Action a propósito:
 * recibe el cliente y el contexto por parámetro, así que se puede testear
 * contra una BD real sin montar un request de Next (§8).
 */

export interface StockMovementResult {
  movementId: string
  productId: string
  warehouseId: string
  /** Stock resultante en ese almacén, ya confirmado por la BD. */
  balanceAfter: number
  version: number
  /** El movimiento ya existía: fue un reintento del cliente, no un duplicado. */
  replayed: boolean
  /** Se permitió quedar bajo cero por política del tenant (§5.4). */
  wentNegative: boolean
}

const P2002_UNIQUE = 'P2002'

function toNumber(d: Prisma.Decimal | number): number {
  return typeof d === 'number' ? d : d.toNumber()
}

/**
 * Garantiza que exista la fila de Stock para (producto, variante, almacén).
 *
 * El `create` puede chocar con otro almacenero registrando el MISMO producto
 * en el mismo instante. En vez de un upsert —que con `variantId` NULL no
 * puede usar ON CONFLICT, porque en Postgres cada NULL es distinto— se
 * intenta insertar y, si el índice parcial `stocks_no_variant_key` lo
 * rechaza, se relee. Perder esa carrera es normal, no un error.
 */
async function ensureStockRow(
  db: TenantPrismaClient,
  tenantId: string,
  input: { productId: string; variantId: string | null; warehouseId: string },
) {
  const where = {
    productId: input.productId,
    variantId: input.variantId,
    warehouseId: input.warehouseId,
  }

  const existing = await db.stock.findFirst({ where })
  if (existing) return existing

  try {
    return await db.stock.create({
      data: { tenantId, ...where, quantity: 0, reserved: 0 },
    })
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === P2002_UNIQUE) {
      const raced = await db.stock.findFirst({ where })
      if (raced) return raced
    }
    throw e
  }
}

/**
 * Cuerpo transaccional del movimiento de stock.
 *
 * Se exporta por separado para que el POS pueda descontar stock DENTRO de la
 * transacción que registra la venta. Prisma no admite $transaction anidadas,
 * así que sin esta separación habría que duplicar la lógica — y el día que
 * alguien corrigiera el guard de concurrencia en un sitio y no en el otro,
 * las ventas volverían a poder dejar el stock en negativo.
 *
 * El llamador es responsable de abrir la transacción y de comprobar el rol.
 *
 * `sourceOverride` existe para que el POS pueda marcar el movimiento como
 * VENTA. El esquema Zod público NO admite ese valor a propósito: si lo
 * hiciera, un cliente podría registrar una salida manual disfrazada de venta
 * y el histórico de inventario dejaría de ser fiable. El origen interno se
 * fija aquí, en código, no en el cuerpo de la petición.
 */
export async function applyStockMovement(
  t: TenantPrismaClient,
  ctx: TenantContext,
  /**
   * `traza`: la presentación con la que se hizo (3 cajas × 12). Solo TRAZABILIDAD: `quantity` sigue siendo la unidad base y es
   * lo único que mueve el stock. La base comprueba que `quantity = enteredQuantity × presentationFactor`.
   */
  input: CreateStockMovementInput & { traza?: { presentationId: string; enteredQuantity: string; factor: string } | null },
  sourceOverride?: MovementSource,
  /**
   * Relaja el guard de stock para ESTA operación.
   *
   * El guard sigue viviendo aquí y en un solo sitio; lo que cambia es que el
   * POS pueda desactivarlo de forma explícita y por venta, en lugar de que
   * el tenant tenga que aflojar su política global.
   */
  allowNegative?: boolean,
  /**
   * Etiqueta el movimiento con un tipo distinto del que trae el input.
   *
   * Existe por las transferencias entre sucursales: el efecto sobre el stock
   * es el de una SALIDA o una ENTRADA —y por tanto debe pasar por el MISMO
   * guard atómico de concurrencia que todo lo demás— pero en el kardex tiene
   * que leerse como TRANSFERENCIA_SALIDA / TRANSFERENCIA_ENTRADA. Sin esto,
   * el servicio de transferencias tendría que reimplementar el
   * `updateManyAndReturn` condicional, que es justo el código que no conviene
   * tener duplicado.
   */
  typeOverride?: MovementType,
): Promise<StockMovementResult> {
  const variantId = input.variantId ?? null

  // 1. Producto: debe existir, ser del tenant (lo garantiza el cliente
  //    aislado) y llevar control de stock.
  const product = await t.product.findFirst({
    where: { id: input.productId, deletedAt: null },
    select: { id: true, name: true, trackStock: true, isActive: true, costPrice: true },
  })

  if (!product) {
    throw new BusinessError('TENANT_MISMATCH', 'El producto no existe.')
  }
  if (!product.trackStock) {
    throw new BusinessError(
      'INSUFFICIENT_STOCK',
      'Este producto no lleva control de stock.',
    )
  }

  const warehouse = await t.warehouse.findFirst({
    where: { id: input.warehouseId, deletedAt: null, isActive: true },
    select: { id: true },
  })
  if (!warehouse) {
    throw new BusinessError('TENANT_MISMATCH', 'El almacén no está disponible.')
  }

  const stock = await ensureStockRow(t, ctx.tenantId, {
    productId: input.productId,
    variantId,
    warehouseId: input.warehouseId,
  })

  const tenant = await t.tenant.findFirstOrThrow({
    select: { stockPolicy: true },
  })

  // 2. Mutación atómica del stock.
  let updated: { quantity: Prisma.Decimal; version: number }
  let delta: number
  let wentNegative = false

  if (input.type === 'AJUSTE') {
    const nuevo = input.quantity
    delta = nuevo - toNumber(stock.quantity)

    const rows = await t.stock.updateManyAndReturn({
      // El guard es la versión que el operario tenía en pantalla.
      where: { id: stock.id, version: input.expectedVersion },
      data: {
        quantity: nuevo,
        version: { increment: 1 },
        lastMovementAt: new Date(),
        lastCountedAt: new Date(),
      },
      select: { quantity: true, version: true },
    })

    const row = rows[0]
    if (!row) {
      throw new BusinessError(
        'STOCK_CONFLICT',
        'Otra persona movió este stock mientras contabas. Vuelve a cargar y repite el ajuste.',
      )
    }
    updated = row
  } else {
    const esSalida = input.type === 'SALIDA'
    delta = esSalida ? -input.quantity : input.quantity

    // El guard solo se aplica a salidas y solo si el tenant bloquea
    // negativos. Con PERMITIR_CON_ADVERTENCIA la venta pasa y se marca.
    // `allowNegative` lo pasa el POS para una venta concreta. El guard sigue
    // viviendo aquí y en un solo sitio; lo que se puede es desactivarlo de
    // forma explícita y por operación, en lugar de obligar al tenant a
    // aflojar su política global para todas las ventas.
    const bloquea =
      esSalida && tenant.stockPolicy === 'BLOQUEAR' && !allowNegative

    const rows = await t.stock.updateManyAndReturn({
      where: bloquea
        ? { id: stock.id, quantity: { gte: input.quantity } }
        : { id: stock.id },
      data: {
        quantity: { increment: delta },
        version: { increment: 1 },
        lastMovementAt: new Date(),
      },
      select: { quantity: true, version: true },
    })

    const row = rows[0]
    if (!row) {
      // Solo puede ocurrir por el guard: la fila existe (la aseguramos
      // arriba) y el tenant ya está filtrado por el cliente aislado.
      throw new BusinessError(
        'INSUFFICIENT_STOCK',
        'No hay stock suficiente para esta salida.',
        {
          disponible: toNumber(stock.quantity),
          solicitado: input.quantity,
          producto: product.name,
        },
      )
    }
    updated = row
    wentNegative = toNumber(updated.quantity) < 0
  }

  const balanceAfter = toNumber(updated.quantity)

  // Kardex valorizado (F6.4): el costo promedio vigente del producto en este instante, leído en la MISMA transacción. Quien cambia ese promedio DESPUÉS
  // (una compra) o fija otro costo (una devolución) corrige estos dos campos en el mismo paso.
  const costoVigente = toNumber(product.costPrice)
  const costoEntrada = input.type === 'ENTRADA' ? input.unitCost : undefined
  const entradaSinCosto = input.type === 'ENTRADA' && !typeOverride && costoEntrada === undefined

  // 3. Ledger. Va DESPUÉS del stock a propósito: si la clave de
  //    idempotencia choca (reintento del móvil), este insert revienta y
  //    toda la transacción — incluida la resta de stock — se deshace.
  //    Esa es exactamente la semántica que queremos en un reintento.
  const movement = await t.stockMovement.create({
    data: {
      tenantId: ctx.tenantId,
      productId: input.productId,
      variantId,
      warehouseId: input.warehouseId,
      userId: ctx.userId,
      type: typeOverride ?? input.type,
      source: sourceOverride ?? input.source,
      quantity: delta,
      // El signo de la cantidad ingresada es el del movimiento: salida = negativa (CHECK: quantity = entered × factor).
      ...(input.traza
        ? {
            presentationId: input.traza.presentationId,
            enteredQuantity: (delta < 0 ? '-' : '') + input.traza.enteredQuantity,
            presentationFactor: input.traza.factor,
          }
        : {}),
      balanceAfter,
      unitCost:
        input.type === 'ENTRADA' && input.unitCost !== undefined
          ? input.unitCost
          : undefined,
      // Entrada manual sin costo: queda «costo pendiente» y no alimenta
      // ningún costo promedio hasta que alguien con `productos.ver_costo` la completa.
      costPending: entradaSinCosto,
      // Una entrada manual sin costo no tiene con qué valorarse hasta que alguien lo complete; todo lo demás se valora a su costo o al promedio vigente.
      unitCostApplied: entradaSinCosto ? null : (costoEntrada ?? costoVigente),
      costAfter: costoVigente,
      costOrigin: 'EXACTO',
      reason: input.reason ?? null,
      referenceType: 'MANUAL',
      idempotencyKey: input.idempotencyKey ?? null,
    },
    select: { id: true },
  })

  // 4. Contador de uso del período (§5.2). Se incrementa para MEDIR, no
  //    para bloquear. Decisión de negocio confirmada: el inventario nunca
  //    se frena por límite de plan — queremos que el ferretero ordene su
  //    almacén sin fricción y perciba el valor. `maxMonthlyTransactions`
  //    se aplica estrictamente sobre Ventas (POS) y Cotizaciones.
  const period = new Date().toISOString().slice(0, 7) // YYYY-MM
  await t.usagePeriod.upsert({
    where: { tenantId_period: { tenantId: ctx.tenantId, period } },
    create: { tenantId: ctx.tenantId, period, movementsCount: 1 },
    update: { movementsCount: { increment: 1 } },
  })

  // 5. Auditoría de ajustes manuales (§6.6).
  if (input.type === 'AJUSTE') {
    await t.auditLog.create({
      data: {
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        actorRole: ctx.role,
        action: 'stock.adjust',
        entityType: 'Stock',
        entityId: stock.id,
        reason: input.reason,
        before: { quantity: toNumber(stock.quantity) },
        after: { quantity: balanceAfter },
        impersonationId: ctx.impersonationId ?? null,
      },
    })
  }

  return {
    movementId: movement.id,
    productId: input.productId,
    warehouseId: input.warehouseId,
    balanceAfter,
    version: updated.version,
    replayed: false,
    wentNegative,
  }
}

/**
 * Registra un movimiento de inventario de forma atómica (§6.2).
 *
 * ─── Por qué está escrito así ────────────────────────────────────────────
 *
 * El error clásico es: leer el stock, comprobar en JavaScript que alcanza, y
 * después restar. Entre la lectura y la escritura cabe otra venta. Dos cajeros
 * con stock 1 venden los dos, y el inventario queda en -1.
 *
 * ENTRADA / SALIDA usan una ÚNICA sentencia condicional:
 *
 *     UPDATE stocks SET quantity = quantity - $n
 *      WHERE id = $id AND quantity >= $n
 *
 * El chequeo y la resta ocurren dentro del mismo statement, así que no hay
 * ventana. Si otra transacción tiene la fila bloqueada, Postgres espera a que
 * commitee y REEVALÚA el WHERE contra la versión nueva (EvalPlanQual). Si ya
 * no alcanza, `count` vuelve 0 y devolvemos stock insuficiente. Sin locks
 * explícitos, sin reintentos, sin SERIALIZABLE.
 *
 * AJUSTE no puede usar ese truco: fija un valor ABSOLUTO calculado contra lo
 * que el operario vio en pantalla. Ahí el guard es la columna `version`
 * (bloqueo optimista): si alguien movió el stock entre que se mostró la
 * pantalla y que se confirmó, el ajuste se rechaza con STOCK_CONFLICT en vez
 * de pisar el trabajo del otro en silencio.
 */
export async function createStockMovement(
  db: TenantPrismaClient,
  ctx: TenantContext,
  input: CreateStockMovementInput,
): Promise<StockMovementResult> {
  // --- Autorización por permiso (§6.4) -------------------------------------
  /*
   * ENTRADA es el trabajo diario del almacenero. AJUSTE y SALIDA reducen o
   * reescriben el inventario a criterio de quien las registra —la forma más
   * fácil de tapar un faltante— y exigen `stock.ajustar`.
   *
   * Que la SALIDA manual cueste más que la ENTRADA es decisión de producto,
   * no accidente: para que el almacenero reporte una pérdida sin tocar el
   * saldo existe la merma con aprobación (`merma-service.ts`).
   */
  const permiso = input.type === 'ENTRADA' ? 'stock.entrada' : 'stock.ajustar'
  if (!puede(ctx, permiso)) {
    throw new BusinessError(
      'FORBIDDEN_ROLE',
      input.type === 'ENTRADA'
        ? 'No tienes permiso para registrar entradas de mercadería.'
        : input.type === 'AJUSTE'
          ? 'No tienes permiso para ajustar el inventario.'
          : 'No tienes permiso para dar salida al inventario. Si es una pérdida, solicita una merma.',
    )
  }

  // Teclear un costo es VER el costo: quien no tiene `productos.ver_costo`
  // registra cantidades, y la entrada queda «costo pendiente».
  if (input.type === 'ENTRADA' && input.unitCost !== undefined && !puede(ctx, 'productos.ver_costo')) {
    throw new BusinessError(
      'FORBIDDEN_ROLE',
      'No tienes permiso para registrar costos. Registra solo la cantidad: el costo lo completa quien tenga acceso.',
    )
  }

  const variantId = input.variantId ?? null

  try {
    return await db.$transaction(async (tx) => {
      const t = tx as unknown as TenantPrismaClient
      // Ingreso o salida por presentación (cajas, bultos): el servidor recalcula la cantidad base y la compara con la enviada.
      if ('presentationId' in input && input.presentationId) {
        const producto = await t.product.findFirst({ where: { id: input.productId, deletedAt: null }, select: { unitType: true } })
        if (!producto) throw new BusinessError('TENANT_MISMATCH', 'El producto no existe.')
        const mapa = await cargarPresentaciones(t, [input.presentationId])
        const r = resolverMovimiento(
          { productId: input.productId, variantId: input.variantId, presentationId: input.presentationId, enteredQuantity: input.enteredQuantity!, quantity: input.quantity },
          mapa.get(input.presentationId), producto.unitType,
        )
        const traza = trazaDe(r.presentacion, r.conversion)
        return applyStockMovement(t, ctx, { ...input, traza: { presentationId: traza.presentationId, enteredQuantity: traza.enteredQuantity, factor: traza.factor } })
      }
      return applyStockMovement(t, ctx, input)
    })
  } catch (e) {
    // Reintento del cliente: la transacción se deshizo entera, así que el
    // stock nunca se aplicó dos veces. Devolvemos el resultado original.
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === P2002_UNIQUE &&
      input.idempotencyKey
    ) {
      const previo = await db.stockMovement.findFirst({
        where: { idempotencyKey: input.idempotencyKey },
        select: {
          id: true,
          productId: true,
          warehouseId: true,
          balanceAfter: true,
        },
      })
      if (previo) {
        const stock = await db.stock.findFirst({
          where: {
            productId: previo.productId,
            variantId,
            warehouseId: previo.warehouseId,
          },
          select: { version: true },
        })
        return {
          movementId: previo.id,
          productId: previo.productId,
          warehouseId: previo.warehouseId,
          balanceAfter: toNumber(previo.balanceAfter),
          version: stock?.version ?? 0,
          replayed: true,
          wentNegative: false,
        }
      }
    }
    throw e
  }
}

/**
 * Completa el costo de una entrada marcada «costo pendiente».
 *
 * Solo quien tiene `productos.ver_costo`. Solo entradas manuales aún
 * pendientes: un costo ya fijado no se reescribe por aquí. Queda auditado.
 */
export async function completarCostoEntrada(
  db: TenantPrismaClient,
  ctx: TenantContext,
  movementId: string,
  unitCost: number,
): Promise<void> {
  if (!puede(ctx, 'productos.ver_costo')) {
    throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para registrar costos.')
  }
  if (!Number.isFinite(unitCost) || unitCost < 0) {
    throw new RangeError('El costo debe ser un número mayor o igual a 0.')
  }

  await db.$transaction(async (tx) => {
    const t = tx as unknown as TenantPrismaClient
    const mov = await t.stockMovement.findFirst({
      where: {
        id: movementId, type: 'ENTRADA', costPending: true,
        // Solo entradas de almacenes de las sucursales que este usuario alcanza.
        ...(ctx.branchIds ? { warehouse: { branchId: { in: [...ctx.branchIds] } } } : {}),
      },
      select: { id: true, productId: true, costOrigin: true },
    })
    if (!mov) {
      throw new BusinessError('NOT_FOUND', 'La entrada no existe o ya tiene costo.')
    }
    await t.stockMovement.update({
      where: { id: mov.id },
      // Un movimiento anterior al kardex valorizado (SIN_DATO) no admite cifras sueltas: su costo lo rellena el script de rellenado.
      data: { unitCost, costPending: false, ...(mov.costOrigin !== 'SIN_DATO' ? { unitCostApplied: unitCost } : {}) },
    })
    await t.auditLog.create({
      data: {
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        actorRole: ctx.role,
        action: 'stock.completar_costo',
        entityType: 'StockMovement',
        entityId: mov.id,
        before: { costPending: true },
        after: { unitCost, costPending: false },
        impersonationId: ctx.impersonationId ?? null,
      },
    })
  })
}
