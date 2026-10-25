import { Prisma } from '@/generated/prisma/client'
import { BusinessError } from '@/lib/errors'
import { redondearCentimos } from '@/lib/dinero'
import { topeDescuento, validarDescuentoLinea } from '@/lib/descuentos'
import { requireBranch, type TenantContext } from '@/lib/tenant-context'
import {
  cargarSucursalOperativa, serieDe, turnoAbiertoId,
} from '@/features/branches/queries'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { applyStockMovement } from '@/features/inventory/stock-service'
import { resolverPagos } from './pagos'
import { cargarPresentaciones, resolverLineaDeVenta, trazaDe, type Traza } from '@/features/inventory/presentacion-linea'
import { puede } from '@/lib/puede'
import type { RegisterSaleInput } from './schemas'

const P2002_UNIQUE = 'P2002'

export interface RegisterSaleResult {
  saleId: string
  number: string
  subtotal: number
  taxTotal: number
  discountTotal: number
  total: number
  /** Ya existía: fue un reintento del cliente, no una venta nueva. */
  replayed: boolean
  /** Alguna línea se vendió bajo el stock disponible (§5.4). */
  soldBelowStock: boolean
}

function num(d: Prisma.Decimal | number | null | undefined): number {
  if (d === null || d === undefined) return 0
  return typeof d === 'number' ? d : d.toNumber()
}

/** Redondeo a céntimos. Sin esto, 0.1 + 0.2 acaba en el total de la boleta. */
/**
 * Redondeo a céntimos, half-up. Único en todo el proyecto.
 *
 * Ver src/lib/dinero.ts para el porqué del `toFixed(4)` intermedio.
 */
const cent = redondearCentimos

/**
 * Reserva el siguiente número de un contador, de forma atómica y sin huecos.
 *
 * ─── POR QUÉ ESTE INCREMENTO Y NO LEER-LUEGO-ESCRIBIR ────────────────────
 *
 * `update` con `increment` es una sola sentencia SQL
 * (`UPDATE ... SET next = next + 1 RETURNING next`), así que Postgres
 * bloquea la fila y serializa a los llamadores concurrentes. Dos cajeros
 * cobrando a la vez obtienen números distintos sin que nadie coordine nada.
 *
 * Y va DENTRO de la transacción de la venta a propósito: si la venta falla,
 * el incremento se deshace con ella y el número no se quema. Eso es lo que
 * mantiene la serie sin huecos, que para un comprobante no es una
 * preferencia estética sino un requisito legal.
 *
 * El precio es que el contador se vuelve un punto de serialización: las
 * ventas de una misma serie se encolan. Para una ferretería es irrelevante,
 * y es el coste inevitable de numerar sin huecos.
 */
export async function claimNextNumber(
  t: TenantPrismaClient,
  tenantId: string,
  scope: string,
  series: string,
): Promise<{ correlativo: number; prefix: string; series: string }> {
  const contador = await t.documentCounter.update({
    where: { tenantId_scope_series: { tenantId, scope, series } },
    data: { next: { increment: 1 } },
    select: { next: true, prefix: true, series: true },
  })

  // `update` devuelve el valor YA incrementado; el que nos toca es el previo.
  return {
    correlativo: contador.next - 1,
    prefix: contador.prefix,
    series: contador.series,
  }
}

/**
 * Garantiza que el contador exista. Va fuera de la transacción de la venta:
 * crearlo dentro haría que dos cajeros simultáneos chocasen en el índice
 * único y una de las dos ventas fallara sin motivo real.
 */
export async function ensureCounter(
  db: TenantPrismaClient,
  tenantId: string,
  branchId: string,
  scope: string,
  series: string,
  prefix: string,
): Promise<void> {
  const existe = await db.documentCounter.findFirst({ where: { scope, series } })
  if (existe) return

  try {
    await db.documentCounter.create({
      data: { tenantId, branchId, scope, series, prefix, next: 1 },
    })
  } catch (e) {
    // Otro cajero lo creó en el mismo instante: perder esa carrera es normal.
    if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== P2002_UNIQUE) {
      throw e
    }
  }
}

/**
 * Registra una venta del POS (§5.4, §6.2).
 *
 * TODO ocurre en una sola transacción: cabecera, líneas, pagos, descuento de
 * stock y movimientos del ledger. No hay forma de que quede una venta cobrada
 * cuyo stock no bajó, ni stock descontado sin venta que lo justifique.
 *
 * El stock se descuenta reutilizando `applyStockMovement`, el mismo código
 * que usa el escáner de almacén. Eso importa: el guard de concurrencia que
 * impide dejar el inventario en negativo vive ahí y en un solo sitio.
 */
/**
 * Precios congelados que SOBREESCRIBEN la lista actual, por línea.
 *
 * ─── POR QUÉ NO ESTÁ EN EL ESQUEMA ZOD ───────────────────────────────────
 *
 * Es un argumento aparte de la FUNCIÓN, deliberadamente fuera del cuerpo
 * validado. Si viviera en `RegisterSaleInput`, el navegador podría enviar
 * `priceOverrides` y venderse un taladro a un sol — exactamente el agujero
 * que el resto del servicio evita leyendo los precios de la base.
 *
 * Solo lo rellena código del SERVIDOR con un origen fiable: hoy, las líneas
 * de una cotización guardada.
 *
 * La clave es `productId:variantId` para no confundir variantes del mismo
 * producto.
 */
export type PriceOverrides = Map<string, number>

export function overrideKey(productId: string, variantId: string | null | undefined): string {
  return `${productId}:${variantId ?? ''}`
}

export async function registerSale(
  db: TenantPrismaClient,
  ctx: TenantContext,
  input: RegisterSaleInput,
  priceOverrides?: PriceOverrides,
  opciones: {
    /**
     * Los descuentos ya los autorizó quien armó el pedido o la cotización (con SU
     * tope). El cajero que la cobra no los vuelve a validar contra el suyo: un
     * cajero sin permiso de descuento debe poder cobrar el pedido con descuento
     * que un vendedor autorizado armó.
     */
    descuentosYaAutorizados?: boolean
  } = {},
): Promise<RegisterSaleResult> {
  if (!puede(ctx, 'ventas.cobrar')) {
    throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para cobrar ventas.')
  }

  /*
   * Reintento del mismo cobro (doble toque, red lenta, el cliente no recibió la respuesta): devuelve la venta YA registrada con
   * esa clave. Sin esto cada reintento creaba otra venta —otro número, otro descuento de stock, otro pago—. Se busca antes de
   * hacer cualquier otra cosa; la carrera entre dos envíos simultáneos la resuelve el índice único (ver el catch de abajo).
   * La clave identifica el INTENTO: si el cliente la reutiliza con otro carrito recibe la venta original (el POS la renueva tras
   * cada cobro exitoso).
   */
  if (input.idempotencyKey) {
    const previa = await ventaPorClave(db, input.idempotencyKey)
    if (previa) return previa
  }

  const branchId = requireBranch(ctx)
  const sucursal = await cargarSucursalOperativa(db, branchId)
  const serie = serieDe(sucursal, 'SALE')

  await ensureCounter(db, ctx.tenantId, branchId, 'SALE', serie.series, serie.prefix)

  /*
   * El turno de caja se busca FUERA de la transacción, y es deliberado.
   *
   * La numeración sin huecos serializa las transacciones de la misma serie,
   * así que cada consulta que viva dentro de ese bloque se paga una vez por
   * venta EN FILA. Tenerla dentro costó un timeout de 30 s en la prueba de 12
   * comprobantes simultáneos: la sección serializada no aguanta ni una ida y
   * vuelta extra a Neon.
   *
   * La carrera que esto abre es benigna y acotada: si el turno se cierra
   * entre esta consulta y el INSERT, la venta queda sellada con un turno ya
   * cerrado cuyos totales están congelados. No corrompe nada —el arqueo sigue
   * siendo la foto de lo que había al cerrar— y queda detectable, porque la
   * suma de ventas del turno dejaría de cuadrar con su `salesTotal`.
   *
   * La alternativa (dentro de la transacción) cambiaría ese desajuste
   * detectable por ventas que fallan en hora punta. No es un buen canje.
   */
  const cashSessionId = await turnoAbiertoId(db, branchId)

  /*
   * Caja obligatoria (opcional por negocio): el efectivo solo se cobra dentro
   * de un turno abierto. Sin turno, ese dinero no entra en ningún arqueo y es
   * justo el que se «pierde». Solo se consulta el ajuste cuando NO hay turno
   * abierto, que es el caso raro: la venta normal no paga una consulta más.
   */
  if (!cashSessionId && input.payments.some((p) => p.method === 'EFECTIVO')) {
    const ajustes = await db.tenant.findFirst({ select: { cashRequired: true } })
    if (ajustes?.cashRequired) {
      throw new BusinessError(
        'INVALID_DOCUMENT',
        'Abre la caja antes de cobrar en efectivo. Declara el monto con el que empiezas el turno.',
      )
    }
  }

  try {
  return await db.$transaction(async (tx) => {
      const t = tx as unknown as TenantPrismaClient

      /*
       * El almacén tiene que ser DE ESTA SUCURSAL. El aislamiento por tenant
       * no basta: los almacenes de todas las sucursales pertenecen al mismo
       * negocio, así que sin esta comprobación un cajero podría descontar
       * stock del local de al lado pasando su id.
       */
      const warehouse = await t.warehouse.findFirst({
        where: { id: input.warehouseId, branchId, isActive: true, deletedAt: null },
        select: { id: true },
      })
      if (!warehouse) {
        throw new BusinessError(
          'TENANT_MISMATCH',
          'El almacén no pertenece a tu sucursal o no está disponible.',
        )
      }

      if (input.customerId) {
        const cliente = await t.customer.findFirst({
          where: { id: input.customerId, deletedAt: null },
          select: { id: true },
        })
        if (!cliente) {
          throw new BusinessError('TENANT_MISMATCH', 'El cliente no existe.')
        }
      }

      // --- 1. Precios desde la BASE, nunca del carrito -------------------
      const ids = [...new Set(input.items.map((i) => i.productId))]
      const productos = await t.product.findMany({
        where: { id: { in: ids }, deletedAt: null, isActive: true },
        select: {
          id: true, name: true, sku: true, unitType: true,
          salePrice: true, costPrice: true, taxRate: true, trackStock: true,
        },
      })
      const porId = new Map(productos.map((p) => [p.id, p]))

      const faltante = ids.find((i) => !porId.has(i))
      if (faltante) {
        throw new BusinessError('TENANT_MISMATCH', 'Un producto del carrito ya no está disponible.')
      }

      // Presentaciones de las líneas (caja, saco…): se cargan de la base, igual que los precios.
      const presentaciones = await cargarPresentaciones(t, input.items.flatMap((i) => (i.presentationId ? [i.presentationId] : [])))

      // --- 2. Importes ---------------------------------------------------
      let subtotal = 0
      let taxTotal = 0
      let discountTotal = 0

      const lineas = input.items.map((item) => {
        const p = porId.get(item.productId)!
        // El precio congelado manda sobre la lista: es lo que hace que una
        // cotización signifique algo. Sin esto, el cliente que pidió
        // presupuesto pagaría el precio del día de la conversión.
        // Línea con presentación: el servidor la convierte y la compara con lo que mandó el cliente. Con precio PROPIO de la
        // presentación manda ese precio × lo ingresado (redondeado una vez a céntimos); sin él, el precio base × cantidad base.
        let traza: Traza | null = null
        let propio: { precio: number; bruto: number } | null = null
        if (item.presentationId) {
          const r = resolverLineaDeVenta(
            { productId: item.productId, variantId: item.variantId, presentationId: item.presentationId, enteredQuantity: item.enteredQuantity!, quantity: item.quantity },
            presentaciones.get(item.presentationId), p.unitType,
          )
          traza = trazaDe(r.presentacion, r.conversion)
          if (r.precioPropio) {
            const l = r.conversion as { precioBase: string; totalLinea: string }
            propio = { precio: Number(l.precioBase), bruto: Number(l.totalLinea) }
          }
        }
        const congelado = priceOverrides?.get(overrideKey(item.productId, item.variantId))
        const precio = propio ? propio.precio : (congelado ?? num(p.salePrice))
        const bruto = propio ? propio.bruto : cent(precio * item.quantity)

        if (item.discount > bruto) {
          throw new BusinessError(
            'INSUFFICIENT_STOCK',
            `El descuento de "${p.name}" supera el importe de la línea.`,
            { producto: p.name, importe: bruto, descuento: item.discount },
          )
        }
        // Permiso y tope del rol (src/lib/descuentos.ts). Antes no se comprobaba nada.
        if (!opciones.descuentosYaAutorizados) validarDescuentoLinea(ctx, p.name, bruto, item.discount)

        const neto = cent(bruto - item.discount)
        const tasa = num(p.taxRate)
        /*
         * ─── EL IGV SE CALCULA POR LÍNEA, NO SOBRE EL TOTAL ─────────────
         *
         * Decisión explícita, porque las dos formas dan resultados distintos
         * y solo una cumple lo que exige el UBL de SUNAT.
         *
         * POR LÍNEA (lo que se hace aquí):
         *   base_i = redondear(neto_i / (1 + tasa_i))
         *   igv_i  = neto_i - base_i
         *   subtotal = Σ base_i      taxTotal = Σ igv_i
         *
         * SOBRE EL TOTAL (descartado):
         *   subtotal = redondear(Σ neto_i / (1 + tasa))
         *
         * La segunda es más simple y rompe el documento de dos maneras:
         *
         *   1. Σ base_i ≠ subtotal y Σ igv_i ≠ taxTotal, por los redondeos.
         *      El UBL exige que los totales del comprobante CUADREN con la
         *      suma de sus líneas; si no, SUNAT lo rechaza.
         *   2. Asume una tasa única. En cuanto hay una línea exonerada
         *      (tasa 0) junto a otras al 18 %, «la tasa» no existe y el
         *      cálculo sobre el total declara afecto lo que no lo es.
         *
         * El invariante que esto garantiza —y que `tests/pos-invoicing.ts`
         * comprueba sobre datos reales— es:
         *
         *   Σ lineTotal_i == subtotal + taxTotal == total
         *
         * Se cumple de forma EXACTA, no aproximada, porque `igv_i` se obtiene
         * restando (`neto_i - base_i`) en lugar de multiplicando: así
         * `base_i + igv_i` reconstruye `neto_i` sin residuo por definición.
         */
        // El precio de venta en Perú se muestra CON IGV incluido, así que el
        // impuesto se extrae del total, no se suma encima. Sumarlo haría que
        // la boleta cobrara un 18% más de lo que marca la etiqueta.
        const base = cent(neto / (1 + tasa))
        const igv = cent(neto - base)

        subtotal = cent(subtotal + base)
        taxTotal = cent(taxTotal + igv)
        discountTotal = cent(discountTotal + item.discount)

        return {
          item,
          producto: p,
          traza,
          unitPrice: precio,
          lineTotal: neto,
          taxRate: tasa,
        }
      })

      const total = cent(subtotal + taxTotal)

      // Pagos mixtos: ver `pagos.ts`. Rechaza lo que no cubre el total, el vuelto que no sale del efectivo y el fiado.
      const { pagos } = resolverPagos(total, input.payments)

      // --- 3. Numeración sin huecos --------------------------------------
      const { correlativo, prefix, series } = await claimNextNumber(
        t, ctx.tenantId, 'SALE', serie.series,
      )
      const number = `${prefix}${series}-${String(correlativo).padStart(8, '0')}`

      // --- 4. Cabecera ---------------------------------------------------
      const sale = await t.sale.create({
        data: {
          tenantId: ctx.tenantId,
          branchId,
          warehouseId: input.warehouseId,
          // Resuelto antes de abrir la transacción: ver la nota de arriba.
          cashSessionId,
          customerId: input.customerId ?? null,
          userId: ctx.userId,
          number,
          documentType: input.documentType,
          status: 'COMPLETADA',
          subtotal, taxTotal, discountTotal, total,
          notes: input.notes ?? null,
          idempotencyKey: input.idempotencyKey ?? null,
          completedAt: new Date(),
        },
        select: { id: true, number: true },
      })

      // --- 5. Líneas, con precio y costo CONGELADOS ----------------------
      await t.saleItem.createMany({
        data: lineas.map((l) => ({
          tenantId: ctx.tenantId,
          saleId: sale.id,
          productId: l.producto.id,
          variantId: l.item.variantId ?? null,
          nameSnapshot: l.producto.name,
          skuSnapshot: l.producto.sku,
          unitType: l.producto.unitType,
          quantity: l.item.quantity,
          ...(l.traza ? { presentationId: l.traza.presentationId, enteredQuantity: l.traza.enteredQuantity, presentationFactor: l.traza.factor, presentationName: l.traza.name } : {}),
          unitPrice: l.unitPrice,
          discount: l.item.discount,
          taxRate: l.taxRate,
          unitCost: num(l.producto.costPrice),
          lineTotal: l.lineTotal,
        })),
      })

      // --- 6. Pagos ------------------------------------------------------
      await t.payment.createMany({
        data: pagos.map((p) => ({
          tenantId: ctx.tenantId,
          saleId: sale.id,
          userId: ctx.userId,
          method: p.method,
          amount: p.amount,
          reference: p.reference,
          // El vuelto va en las líneas de EFECTIVO (ver `pagos.ts`), sea cual sea su posición.
          change: p.change,
        })),
      })

      // --- 7. Stock, con el MISMO código que el escáner ------------------
      let soldBelowStock = false
      for (const l of lineas) {
        if (!l.producto.trackStock) continue

        const mov = await applyStockMovement(t, ctx, {
          type: 'SALIDA',
          productId: l.producto.id,
          variantId: l.item.variantId ?? null,
          warehouseId: input.warehouseId,
          quantity: l.item.quantity,
          source: 'MANUAL',
          traza: l.traza,
          reason: input.allowNegativeStock
            ? `Venta ${number} (forzada: stock insuficiente)`
            : `Venta ${number}`,
          // Sin clave propia: la idempotencia de la venta entera la da el
          // único de Sale.number, y la transacción cubre estos movimientos.
        }, 'VENTA', input.allowNegativeStock)
        if (mov.wentNegative) soldBelowStock = true
      }

      if (soldBelowStock) {
        await t.sale.update({
          where: { id: sale.id },
          data: { soldBelowStock: true },
        })

        // Se audita con el detalle de QUÉ quedó negativo. La marca en la
        // venta dice que pasó; esto dice qué contar, que es lo accionable.
        const negativos: Record<string, number> = {}
        for (const l of lineas) {
          if (!l.producto.trackStock) continue
          const s = await t.stock.findFirst({
            where: {
              productId: l.producto.id,
              variantId: l.item.variantId ?? null,
              warehouseId: input.warehouseId,
            },
            select: { quantity: true },
          })
          const q = num(s?.quantity)
          if (q < 0) negativos[l.producto.name] = q
        }

        await t.auditLog.create({
          data: {
            tenantId: ctx.tenantId,
            actorId: ctx.userId,
            actorRole: ctx.role,
            action: 'sale.below_stock',
            entityType: 'Sale',
            entityId: sale.id,
            reason: input.allowNegativeStock
              ? 'El cajero forzó la venta: el producto estaba físicamente disponible'
              : 'Política del tenant permite stock negativo',
            after: { venta: number, forzada: input.allowNegativeStock, negativos },
            impersonationId: ctx.impersonationId ?? null,
          },
        })
      }

      // Los descuentos quedan a la vista: quién, cuánto y con qué tope.
      if (discountTotal > 0 && !opciones.descuentosYaAutorizados) {
        await t.auditLog.create({
          data: {
            tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role,
            action: 'sale.discount', entityType: 'Sale', entityId: sale.id,
            after: { venta: number, descuento: discountTotal, tope: topeDescuento(ctx) },
            impersonationId: ctx.impersonationId ?? null,
          },
        })
      }

      // --- 8. Contador de uso del período (§5.2) -------------------------
      // Aquí SÍ se mide para cobrar: maxMonthlyTransactions se aplica sobre
      // ventas, no sobre movimientos de inventario.
      const period = new Date().toISOString().slice(0, 7)
      await t.usagePeriod.upsert({
        where: { tenantId_period: { tenantId: ctx.tenantId, period } },
        create: { tenantId: ctx.tenantId, period, salesCount: 1 },
        update: { salesCount: { increment: 1 } },
      })

      return {
        saleId: sale.id,
        number: sale.number,
        subtotal, taxTotal, discountTotal, total,
        replayed: false,
        soldBelowStock,
      }
    },
    {
      /**
       * Tiempos ampliados a propósito.
       *
       * El contador de correlativos SERIALIZA las transacciones de una misma
       * serie: es el precio inevitable de numerar sin huecos. Con la base en
       * otra región —Neon, ~130 ms por consulta— cada transacción tarda cerca
       * de un segundo, así que varias ventas simultáneas encolan más de los
       * 2 s que Prisma espera por defecto antes de rendirse, y la venta falla
       * sin que nada esté mal.
       *
       * LÍMITE CONOCIDO: esto fija un techo de rendimiento. Una serie admite
       * del orden de una venta por segundo. Para una ferretería con dos o
       * tres cajas sobra; una cadena con veinte cajas necesitaría una serie
       * por caja, que es además como lo resuelve la norma.
       */
      maxWait: 15_000,
      timeout: 30_000,
    },
  )
  } catch (e) {
    // Dos envíos simultáneos con la misma clave: uno ganó el índice único y el otro se deshizo entero (venta, pagos, stock).
    // Se entrega la venta ganadora. Solo si de verdad existe una con esa clave: cualquier otro P2002 sigue siendo un error.
    if (input.idempotencyKey && e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const ganadora = await ventaPorClave(db, input.idempotencyKey)
      if (ganadora) return ganadora
    }
    throw e
  }
}

/** La venta ya registrada con esa clave de idempotencia (del negocio de `db`), lista para devolverse como reintento. */
async function ventaPorClave(db: TenantPrismaClient, idempotencyKey: string): Promise<RegisterSaleResult | null> {
  const v = await db.sale.findFirst({
    where: { idempotencyKey },
    select: { id: true, number: true, subtotal: true, taxTotal: true, discountTotal: true, total: true, soldBelowStock: true },
  })
  if (!v) return null
  return {
    saleId: v.id, number: v.number,
    subtotal: num(v.subtotal), taxTotal: num(v.taxTotal), discountTotal: num(v.discountTotal), total: num(v.total),
    replayed: true, soldBelowStock: v.soldBelowStock,
  }
}
