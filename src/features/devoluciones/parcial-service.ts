import { Prisma } from '@/generated/prisma/client'
import { BusinessError } from '@/lib/errors'
import { diaLocal } from '@/lib/periodos'
import { P2002_UNIQUE } from '@/lib/prisma-errors'
import { exigir } from '@/lib/puede'
import type { TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { bloquearTurno, cargarSucursalOperativa, serieDe } from '@/features/branches/queries'
import { reducirCuentaEn } from '@/features/credito/credito-service'
import { applyStockMovement } from '@/features/inventory/stock-service'
import { emitirNotaCreditoParcialEn, prepararNotaCreditoParcial, type LineaNotaParcial } from '@/features/invoicing/service'
import { claimNextNumber, ensureCounter } from '@/features/pos/sale-service'
import type { DevolverProductosInput } from './schemas'
import {
  aDiezmilesimas, avisoAntiguedad, contadoRestante, deDiezmilesimas, planDeComprobanteParcial, repartirDeudaYDinero, repartirEnProporcion, resolverLineas, topeDevolvibleCent,
  type EstadoCuenta, type LineaResuelta, type LineaVendida, type PlanComprobanteParcial, type ReparteDeudaDinero,
} from './parcial'
import { efectivoDelCajon, necesitaCaja, pagadoNeto, validarReembolsos, type MedioPago, type PagadoNeto, type ReembolsoValido } from './reglas'
import { turnoAbiertoDe } from './service'

/**
 * Devolver PRODUCTOS (parte de las líneas) de una venta COMPLETADA (F6.2a). Una sola transacción. Diseño: docs/F6.2-DISENO.md.
 *
 *  · Permiso: `ventas.anular` y nada más (fuera del PIN). La nota parcial, la reducción de la deuda y la merma son núcleos SIN permiso propio:
 *    las autoriza esta operación.
 *  · Orden de bloqueos (el de F6.1): venta → cliente → turno de caja → productos. Todo lo que se devuelve de una línea se acumula en
 *    `sale_items.returnedQuantity/returnedAmount` con un UPDATE condicional y la base lo vigila con un CHECK: nunca se devuelve más de lo vendido.
 *  · Lo devuelto se reparte primero contra la deuda de la venta (fiado) y el resto es dinero (CAJA / EXTERNO / SIN_SALIDA, como en F6.1).
 *  · Lo dañado va a merma en la misma transacción: entrada por devolución + salida por merma + merma ya aprobada (stock vendible intacto).
 *  · Con comprobante real vivo emite UNA nota de crédito parcial (07 ⚠️) con sus líneas; si la devolución deja la venta sin nada por devolver,
 *    la venta pasa a DEVUELTA.
 */

const num = (v: unknown): number => Number(v ?? 0)
const cent = (v: unknown): number => Math.round(num(v) * 100)
const invalido = (m: string) => new BusinessError('INVALID_DOCUMENT', m)
const OPCIONES_TX = { maxWait: 15_000, timeout: 30_000 } as const

export interface ResultadoDevolucionParcial {
  returnId: string
  number: string
  saleId: string
  saleNumber: string
  /** DEVUELTA si con esta devolución no queda nada por devolver; si no, la venta sigue COMPLETADA. */
  status: 'COMPLETADA' | 'DEVUELTA'
  completaVenta: boolean
  total: number
  creditNote: { id: string; fullNumber: string } | null
  refunds: { mode: 'CAJA' | 'EXTERNO' | 'SIN_SALIDA'; method: string | null; amount: number }[]
  /** Cuánto de lo devuelto bajó la deuda del cliente. */
  receivableReducedAmount: number
  lines: { saleItemId: string; quantity: number; amount: number; destination: 'STOCK' | 'MERMA' | 'SIN_STOCK' }[]
  mermas: number
  /** Días desde la venta, y si pasan del umbral operativo (⚠️ solo aviso, nunca bloquea). */
  antiguedad: { dias: number; avisar: boolean }
  replayed: boolean
}

// ─── Lectura y evaluación ───────────────────────────────────────────────────────────────────────────────────────────────────────

async function leerVenta(t: TenantPrismaClient, saleId: string) {
  return t.sale.findFirst({
    where: { id: saleId },
    select: {
      id: true, number: true, status: true, branchId: true, warehouseId: true, total: true, completedAt: true,
      items: {
        orderBy: { id: 'asc' },
        select: {
          id: true, productId: true, variantId: true, quantity: true, lineTotal: true, taxRate: true, returnedQuantity: true, returnedAmount: true,
          nameSnapshot: true, skuSnapshot: true, unitType: true, unitCost: true,
          presentationId: true, enteredQuantity: true, presentationFactor: true, presentationName: true,
          product: { select: { trackStock: true, deletedAt: true } },
        },
      },
      payments: { select: { method: true, amount: true, change: true } },
      receivable: { select: { id: true, status: true, amount: true, paidAmount: true } },
      taxDocuments: { where: { documentType: { in: ['BOLETA', 'FACTURA'] } }, take: 1, select: { id: true, status: true, isTrial: true, fullNumber: true } },
      saleReturns: { select: { refunds: { select: { method: true, amount: true } } } },
    },
  })
}
type Venta = NonNullable<Awaited<ReturnType<typeof leerVenta>>>

const lineaVendida = (i: Venta['items'][number]): LineaVendida => ({
  id: i.id, nombre: i.nameSnapshot, trackStock: i.product.trackStock, totalCent: cent(i.lineTotal), vendidaM: aDiezmilesimas(num(i.quantity)), tasa: num(i.taxRate),
  yaDevueltaM: aDiezmilesimas(num(i.returnedQuantity)), yaDevueltoImporteCent: cent(i.returnedAmount),
})

/** Lo pagado al contado que sigue sin devolverse, y la cuenta de la venta, en céntimos. */
function situacionDeDinero(venta: Venta) {
  const pagado = pagadoNeto(venta.payments.map((p) => ({ method: p.method, amount: num(p.amount), change: num(p.change) })))
  const yaDevuelto = venta.saleReturns.flatMap((r) => r.refunds.map((x) => ({ method: x.method, cent: cent(x.amount) })))
  const restante = contadoRestante(pagado.porMedio.map((m) => ({ method: m.method, cent: m.cent })), yaDevuelto)
  const cuenta: EstadoCuenta | null = venta.receivable ? { status: venta.receivable.status, amountCent: cent(venta.receivable.amount), paidCent: cent(venta.receivable.paidAmount) } : null
  return { pagado, restante, cuenta }
}

interface Evaluacion {
  venta: Venta
  lineas: LineaResuelta[]
  totalCent: number
  completaVenta: boolean
  reparto: Extract<ReparteDeudaDinero, { ok: true }>
  reembolsos: ReembolsoValido[]
  planDoc: PlanComprobanteParcial
}

function lineasParaNota(venta: Venta, lineas: readonly LineaResuelta[]): LineaNotaParcial[] {
  const porId = new Map(venta.items.map((i) => [i.id, i]))
  return lineas.map((l) => {
    const i = porId.get(l.saleItemId)!
    return { saleItemId: l.saleItemId, descripcion: i.nameSnapshot, sku: i.skuSnapshot, unitType: i.unitType, cantidad: deDiezmilesimas(l.cantidadM), tasa: l.tasa, baseCent: l.baseCent, igvCent: l.igvCent }
  })
}

async function evaluar(t: TenantPrismaClient, input: DevolverProductosInput): Promise<Evaluacion> {
  const venta = await leerVenta(t, input.saleId)
  if (!venta) throw new BusinessError('NOT_FOUND', 'La venta no existe.')
  if (venta.status !== 'COMPLETADA') {
    throw invalido(venta.status === 'ANULADA' || venta.status === 'DEVUELTA' ? `La venta ${venta.number} ya está ${venta.status.toLowerCase()}.` : `Solo se devuelven productos de una venta completada; la ${venta.number} está ${venta.status.toLowerCase()}.`)
  }

  const r = resolverLineas(venta.items.map(lineaVendida), input.lines.map((l) => ({ saleItemId: l.saleItemId, cantidad: l.quantity, destino: l.destination })))
  if (!r.ok) throw invalido(r.mensaje)

  // Producto con control de stock dado de baja: no puede recibir el stock de vuelta (decisión de F6.1, también aquí).
  const bajas = [...new Set(r.lineas.filter((l) => l.trackStock).map((l) => venta.items.find((i) => i.id === l.saleItemId)!).filter((i) => i.product.deletedAt !== null).map((i) => i.nameSnapshot))]
  if (bajas.length > 0) {
    throw invalido(`No se puede devolver el stock de ${bajas.map((n) => `«${n}»`).join(', ')}: ${bajas.length === 1 ? 'el producto está dado de baja' : 'los productos están dados de baja'}. Reactívalo${bajas.length === 1 ? '' : 's'} para poder reingresar el stock y vuelve a intentar.`)
  }

  const doc = venta.taxDocuments[0]
  const planDoc = planDeComprobanteParcial(doc ? { estado: doc.status, isTrial: doc.isTrial, numero: doc.fullNumber } : null, r.completaVenta)
  if (planDoc.accion === 'BLOQUEAR') throw invalido(planDoc.mensaje)

  const { restante, cuenta } = situacionDeDinero(venta)
  const reparto = repartirDeudaYDinero(r.totalCent, cuenta, restante.totalCent)
  if (!reparto.ok) throw new BusinessError(reparto.code, reparto.mensaje, { topeDevolvible: reparto.topeCent / 100 })

  let reembolsos: ReembolsoValido[] = []
  if (reparto.dineroCent === 0) {
    if (input.refunds && input.refunds.length > 0) throw invalido('Lo devuelto se descuenta de la deuda del cliente: no hay dinero que reembolsar.')
  } else {
    // Por defecto el dinero vuelve en proporción a lo que cada medio aún tiene sin devolver.
    const sugerido = repartirEnProporcion(reparto.dineroCent, restante.porMedio)
    const pagado: PagadoNeto = { netoCent: reparto.dineroCent, fiadoCent: 0, porMedio: sugerido.map((x) => ({ method: x.method as MedioPago, cent: x.cent })) }
    const v = validarReembolsos(input.refunds?.map((x) => ({ mode: x.mode, method: x.method ?? null, amount: x.amount, reference: x.reference ?? null })), pagado)
    if (!v.ok) throw invalido(v.mensaje)
    reembolsos = v.reembolsos
  }
  return { venta, lineas: r.lineas, totalCent: r.totalCent, completaVenta: r.completaVenta, reparto, reembolsos, planDoc }
}

// ─── Resultado ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const seleccion = {
  id: true, number: true, saleId: true, isFull: true, returnTotal: true, receivableVoidedAmount: true, createdAt: true,
  sale: { select: { number: true, status: true, completedAt: true } }, creditNote: { select: { id: true, fullNumber: true } },
  refunds: { select: { mode: true, method: true, amount: true } },
  items: { select: { saleItemId: true, quantity: true, amount: true, destination: true } },
} as const

function resultadoDe(r: Prisma.SaleReturnGetPayload<{ select: typeof seleccion }>, replayed: boolean, diaHoy: string, zona: string): ResultadoDevolucionParcial {
  return {
    returnId: r.id, number: r.number, saleId: r.saleId, saleNumber: r.sale.number, status: r.sale.status === 'DEVUELTA' ? 'DEVUELTA' : 'COMPLETADA', completaVenta: r.isFull,
    total: num(r.returnTotal), creditNote: r.creditNote, refunds: r.refunds.map((x) => ({ mode: x.mode, method: x.method, amount: num(x.amount) })),
    receivableReducedAmount: num(r.receivableVoidedAmount),
    lines: r.items.map((i) => ({ saleItemId: i.saleItemId, quantity: num(i.quantity), amount: num(i.amount), destination: i.destination })),
    mermas: r.items.filter((i) => i.destination === 'MERMA').length,
    antiguedad: avisoAntiguedad(diaLocal(zona, r.sale.completedAt ?? r.createdAt), diaHoy), replayed,
  }
}

async function porClave(t: TenantPrismaClient, input: DevolverProductosInput): Promise<ResultadoDevolucionParcial | null> {
  const previa = await t.saleReturn.findFirst({ where: { idempotencyKey: input.idempotencyKey }, select: seleccion })
  if (!previa) return null
  if (previa.saleId !== input.saleId) throw invalido('Esa clave de operación ya se usó con otra venta.')
  const zona = (await t.tenant.findFirstOrThrow({ select: { timezone: true } })).timezone
  return resultadoDe(previa, true, diaLocal(zona, new Date()), zona)
}

// ─── La operación ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

export async function devolverProductosVenta(db: TenantPrismaClient, ctx: TenantContext, input: DevolverProductosInput): Promise<ResultadoDevolucionParcial> {
  exigir(ctx, 'ventas.anular')
  const ya = await porClave(db, input)
  if (ya) return ya

  // Fuera de la transacción: fallar rápido con el mensaje claro y dejar listo lo que no puede crearse dentro (contadores).
  const previa = await evaluar(db, input)
  if (necesitaCaja(previa.reembolsos)) await turnoAbiertoDe(db, previa.venta.branchId)
  const motivoNota = `Devolución parcial de la venta ${previa.venta.number}: ${input.reason}`.slice(0, 250)
  if (previa.planDoc.accion === 'EMITIR_NOTA') {
    await prepararNotaCreditoParcial(db, ctx, { saleId: input.saleId, reasonDescription: motivoNota, lineas: lineasParaNota(previa.venta, previa.lineas) })
  }
  const sucursal = await cargarSucursalOperativa(db, previa.venta.branchId)
  const serie = serieDe(sucursal, 'RETURN')
  await ensureCounter(db, ctx.tenantId, sucursal.id, 'RETURN', serie.series, serie.prefix)

  try {
    return await db.$transaction(async (tx) => {
      const t = tx as unknown as TenantPrismaClient

      // 1. La venta, bloqueada: dos devoluciones a la vez se turnan y la segunda ve lo que dejó la primera.
      await t.sale.update({ where: { id: input.saleId }, data: { updatedAt: new Date() }, select: { id: true } })
      const repetida = await porClave(t, input)
      if (repetida) return repetida
      const ev = await evaluar(t, input)
      const { venta } = ev

      const n = await claimNextNumber(t, ctx.tenantId, 'RETURN', serie.series)
      const number = `${n.prefix}${n.series}-${String(n.correlativo).padStart(8, '0')}`
      const motivo = `Devolución parcial ${number}: ${input.reason}`.slice(0, 250)

      // 2. Crédito: la deuda baja lo que cabe en el saldo (bloquea al cliente primero).
      if (ev.reparto.accion !== 'NINGUNA') {
        await reducirCuentaEn(t, ctx, { receivableId: venta.receivable!.id, montoCent: ev.reparto.deudaCent, motivo }, { devolucion: number })
      }

      // 3. Caja: el efectivo sale del turno abierto AHORA (bloqueado); los reembolsos por otro medio anotan el turno abierto, si lo hay.
      let turnoId: string | null = null
      if (ev.reembolsos.length > 0) {
        const abierto = await t.cashSession.findFirst({ where: { branchId: venta.branchId, status: 'ABIERTA' }, select: { id: true } })
        if (abierto && (await bloquearTurno(t, abierto.id)).status === 'ABIERTA') turnoId = abierto.id
        if (necesitaCaja(ev.reembolsos) && !turnoId) throw new BusinessError('CASH_REQUIRED', 'Para devolver dinero en efectivo desde el cajón hace falta un turno de caja abierto en la sucursal de la venta. Abre la caja, o elige devolverlo por otro medio.')
      }

      // 4. Comprobante: la nota parcial nace en ESTA transacción (o, si la venta queda devuelta del todo, se marca el comprobante de ensayo).
      let nota: { id: string; fullNumber: string } | null = null
      if (ev.planDoc.accion === 'EMITIR_NOTA') {
        const emitida = await emitirNotaCreditoParcialEn(t, ctx, { saleId: input.saleId, reasonDescription: motivoNota, lineas: lineasParaNota(venta, ev.lineas) })
        if (cent(emitida.total) !== ev.totalCent) throw invalido('La nota de crédito no cuadra con lo devuelto.')
        nota = { id: emitida.id, fullNumber: emitida.fullNumber }
      } else if (ev.planDoc.accion === 'MARCAR_ENSAYO') {
        await t.taxDocument.updateMany({ where: { saleId: input.saleId, isTrial: true }, data: { voidedAt: new Date(), voidReason: motivo } })
      }

      // 5. El registro de la devolución y sus reembolsos.
      const registro = await t.saleReturn.create({
        data: {
          tenantId: ctx.tenantId, saleId: input.saleId, kind: 'DEVOLUCION', number, reason: input.reason, isFull: ev.completaVenta, userId: ctx.userId,
          creditNoteId: nota?.id ?? null, saleTotal: num(venta.total), returnTotal: ev.totalCent / 100, paidNet: ev.reparto.dineroCent / 100,
          receivableVoidedAmount: ev.reparto.deudaCent / 100, idempotencyKey: input.idempotencyKey,
        },
        select: { id: true },
      })
      if (ev.reembolsos.length > 0) {
        await t.saleReturnRefund.createMany({
          data: ev.reembolsos.map((r) => ({ tenantId: ctx.tenantId, returnId: registro.id, mode: r.mode, method: r.method, amount: r.amount, reference: r.reference, cashSessionId: turnoId })),
        })
      }

      // 6. Líneas: el tope por línea (UPDATE condicional: si otro cambió la línea entre la lectura y aquí, se deshace todo), el stock y las mermas.
      const porId = new Map(venta.items.map((i) => [i.id, i]))
      const ordenadas = [...ev.lineas].sort((a, b) => {
        const x = porId.get(a.saleItemId)!, y = porId.get(b.saleItemId)!
        return x.productId < y.productId ? -1 : x.productId > y.productId ? 1 : x.id < y.id ? -1 : 1
      })
      const mermaPorLinea = new Map<string, string>()
      for (const l of ordenadas) {
        const i = porId.get(l.saleItemId)!
        const antesM = l.nuevaDevueltaM - l.cantidadM
        const cas = await t.saleItem.updateMany({
          where: { id: i.id, returnedQuantity: deDiezmilesimas(antesM) },
          data: { returnedQuantity: deDiezmilesimas(l.nuevaDevueltaM), returnedAmount: (cent(i.returnedAmount) + l.importeCent) / 100 },
        })
        if (cas.count !== 1) throw invalido(`«${i.nameSnapshot}» cambió mientras se devolvía. Vuelve a intentarlo.`)

        if (l.destino === 'SIN_STOCK') continue
        const cantidad = deDiezmilesimas(l.cantidadM)
        const traza = i.presentationId && i.enteredQuantity !== null && i.presentationFactor !== null ? trazaDe(i.presentationId, cantidad, num(i.presentationFactor)) : null
        const entrada = await applyStockMovement(t, ctx, {
          type: 'ENTRADA', productId: i.productId, variantId: i.variantId ?? null, warehouseId: venta.warehouseId, quantity: cantidad, source: 'MANUAL', traza,
          reason: `Devolución parcial de la venta ${venta.number} (${number})`,
        }, 'VENTA', undefined, 'DEVOLUCION_CLIENTE')
        await t.stockMovement.update({ where: { id: entrada.movementId }, data: { referenceType: 'DEVOLUCION', referenceId: registro.id, unitCost: i.unitCost }, select: { id: true } })

        if (l.destino === 'MERMA') {
          // Dañado: sale en el acto del stock vendible. Entrada y salida netas = 0; el kardex cuenta las dos.
          const salida = await applyStockMovement(t, ctx, {
            type: 'SALIDA', productId: i.productId, variantId: i.variantId ?? null, warehouseId: venta.warehouseId, quantity: cantidad, source: 'MANUAL', traza: null,
            reason: `Merma por devolución dañada de la venta ${venta.number} (${number})`,
          }, 'VENTA', undefined, 'MERMA')
          await t.stockMovement.update({ where: { id: salida.movementId }, data: { referenceType: 'DEVOLUCION', referenceId: registro.id, unitCost: i.unitCost }, select: { id: true } })
          const ahora = new Date()
          const merma = await t.merma.create({
            data: {
              tenantId: ctx.tenantId, branchId: venta.branchId, warehouseId: venta.warehouseId, productId: i.productId, variantId: i.variantId ?? null,
              nameSnapshot: i.nameSnapshot, skuSnapshot: i.skuSnapshot, unitType: i.unitType, quantity: cantidad,
              reason: `Devolución dañada ${number}: ${input.reason}`.slice(0, 250), status: 'APROBADA',
              requestedById: ctx.userId, resolvedById: ctx.userId, resolvedAt: ahora, movementId: salida.movementId,
            },
            select: { id: true },
          })
          mermaPorLinea.set(i.id, merma.id)
        }
      }
      await t.saleReturnItem.createMany({
        data: ev.lineas.map((l) => {
          const i = porId.get(l.saleItemId)!
          const cantidad = deDiezmilesimas(l.cantidadM)
          const entrada = i.presentationFactor !== null ? enteredDe(cantidad, num(i.presentationFactor)) : null
          return {
            tenantId: ctx.tenantId, returnId: registro.id, saleItemId: i.id, quantity: cantidad, amount: l.importeCent / 100, subtotal: l.baseCent / 100, taxAmount: l.igvCent / 100,
            taxRate: l.tasa, destination: l.destino, mermaId: mermaPorLinea.get(i.id) ?? null,
            enteredQuantity: entrada, presentationName: entrada === null ? null : i.presentationName,
          }
        }),
      })

      // 7. La venta pasa a DEVUELTA solo si no queda nada por devolver.
      if (ev.completaVenta) {
        await t.sale.update({ where: { id: input.saleId }, data: { status: 'DEVUELTA', voidedAt: new Date(), voidReason: input.reason }, select: { id: true } })
      }

      const accionDeAuditoria = ev.completaVenta ? { action: 'venta.devuelta' } : { action: 'venta.devuelta_parcial' }
      await t.auditLog.create({
        data: {
          tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role,
          ...accionDeAuditoria, entityType: 'Sale', entityId: input.saleId, reason: input.reason,
          before: { estado: 'COMPLETADA' },
          after: {
            devolucion: number, venta: venta.number, estado: ev.completaVenta ? 'DEVUELTA' : 'COMPLETADA', parcial: !ev.completaVenta, total: ev.totalCent / 100,
            lineas: ev.lineas.map((l) => ({ producto: porId.get(l.saleItemId)!.nameSnapshot, cantidad: deDiezmilesimas(l.cantidadM), importe: l.importeCent / 100, destino: l.destino })),
            deudaReducida: ev.reparto.deudaCent / 100, dinero: ev.reparto.dineroCent / 100,
            reembolsos: ev.reembolsos.map((r) => ({ modo: r.mode, medio: r.method, monto: r.amount })), efectivoDelCajon: efectivoDelCajon(ev.reembolsos),
            notaDeCredito: nota?.fullNumber ?? null, comprobante: ev.planDoc.accion, mermas: mermaPorLinea.size,
          },
          impersonationId: ctx.impersonationId ?? null,
        },
      })

      const guardada = await t.saleReturn.findFirstOrThrow({ where: { id: registro.id }, select: seleccion })
      const zona = (await t.tenant.findFirstOrThrow({ select: { timezone: true } })).timezone
      return resultadoDe(guardada, false, diaLocal(zona, new Date()), zona)
    }, OPCIONES_TX)
  } catch (e) {
    // Reintento (o dos a la vez) con la misma clave, o dos devoluciones que ambas completan la venta: la base corta a la segunda.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === P2002_UNIQUE) {
      const ganadora = await porClave(db, input)
      if (ganadora) return ganadora
      const ahora = await db.sale.findFirst({ where: { id: input.saleId }, select: { status: true } })
      throw invalido(ahora?.status === 'DEVUELTA' ? 'Esa venta ya fue devuelta por completo.' : 'No se pudo registrar la devolución: otra operación se cruzó (el número ya existía). Vuelve a intentarlo.')
    }
    throw e
  }
}

/** La cantidad en la presentación vendida, solo si es exacta (la base comprueba `cantidad = ingresada × factor`). */
function enteredDe(cantidad: number, factor: number): number | null {
  if (!(factor > 0)) return null
  const e = Math.round((cantidad / factor) * 10_000) / 10_000
  return Math.abs(e * factor - cantidad) < 1e-9 ? e : null
}
function trazaDe(presentationId: string, cantidad: number, factor: number) {
  const e = enteredDe(cantidad, factor)
  return e === null ? null : { presentationId, enteredQuantity: String(e), factor: String(factor) }
}

// ─── Lo que la pantalla necesita saber ANTES de devolver ────────────────────────────────────────────────────────────────────────────

export interface LineaDevolvible {
  saleItemId: string
  nombre: string
  sku: string
  /** Unidades base vendidas / ya devueltas / por devolver. */
  vendida: number
  devuelta: number
  pendiente: number
  /** Importe de lo que queda por devolver (con IGV). */
  importePendiente: number
  controlaStock: boolean
  presentacion: { nombre: string; factor: number } | null
  /** Los datos exactos con que la pantalla calcula EN VIVO el importe de lo que pide (la misma función que el servidor): sin costos. */
  calculo: { totalCent: number; vendidaM: number; tasa: number; yaDevueltaM: number; yaDevueltoImporteCent: number }
}

export interface DiagnosticoParcial {
  puede: boolean
  bloqueo: { code: string; mensaje: string } | null
  lineas: LineaDevolvible[]
  /** Lo máximo que se puede devolver ahora: saldo pendiente de la deuda + lo pagado al contado que sigue sin devolver. */
  topeDevolvible: number
  saldoDeuda: number
  contadoSinDevolver: { method: string; amount: number }[]
  /** La cuenta por cobrar de la venta y lo pagado al contado que sigue sin devolverse, en céntimos, para repartir deuda y dinero en pantalla. */
  cuenta: EstadoCuenta | null
  contadoPorMedioCent: { method: string; cent: number }[]
  hayTurnoAbierto: boolean
  /** Si la venta ya tiene alguna devolución: «Anular/Devolver todo» deja de ofrecerse. */
  tieneDevoluciones: boolean
  comprobante: { numero: string; estado: string; esEnsayo: boolean } | null
  antiguedad: { dias: number; avisar: boolean }
}

export async function diagnosticarDevolucionParcial(db: TenantPrismaClient, ctx: TenantContext, saleId: string): Promise<DiagnosticoParcial> {
  exigir(ctx, 'ventas.anular')
  const venta = await leerVenta(db, saleId)
  if (!venta) throw new BusinessError('NOT_FOUND', 'La venta no existe.')
  const zona = (await db.tenant.findFirstOrThrow({ select: { timezone: true } })).timezone
  const { restante, cuenta } = situacionDeDinero(venta)
  const turno = await db.cashSession.findFirst({ where: { branchId: venta.branchId, status: 'ABIERTA' }, select: { id: true } })
  const doc = venta.taxDocuments[0]
  const lineas = venta.items.map((i): LineaDevolvible => {
    const v = lineaVendida(i), pend = v.vendidaM - v.yaDevueltaM
    return {
      saleItemId: i.id, nombre: i.nameSnapshot, sku: i.skuSnapshot, vendida: deDiezmilesimas(v.vendidaM), devuelta: deDiezmilesimas(v.yaDevueltaM), pendiente: deDiezmilesimas(pend),
      importePendiente: (v.totalCent - v.yaDevueltoImporteCent) / 100, controlaStock: i.product.trackStock,
      presentacion: i.presentationName && i.presentationFactor !== null ? { nombre: i.presentationName, factor: num(i.presentationFactor) } : null,
      calculo: { totalCent: v.totalCent, vendidaM: v.vendidaM, tasa: v.tasa, yaDevueltaM: v.yaDevueltaM, yaDevueltoImporteCent: v.yaDevueltoImporteCent },
    }
  })
  let bloqueo: DiagnosticoParcial['bloqueo'] = null
  if (venta.status !== 'COMPLETADA') bloqueo = { code: 'INVALID_DOCUMENT', mensaje: `La venta ${venta.number} está ${venta.status.toLowerCase()}: no admite devoluciones.` }
  else if (lineas.every((l) => l.pendiente === 0)) bloqueo = { code: 'INVALID_DOCUMENT', mensaje: 'Todo lo vendido ya se devolvió.' }
  else {
    const plan = planDeComprobanteParcial(doc ? { estado: doc.status, isTrial: doc.isTrial, numero: doc.fullNumber } : null, false)
    if (plan.accion === 'BLOQUEAR') bloqueo = { code: 'INVALID_DOCUMENT', mensaje: plan.mensaje }
  }
  return {
    puede: bloqueo === null, bloqueo, lineas, topeDevolvible: topeDevolvibleCent(cuenta, restante.totalCent) / 100,
    saldoDeuda: cuenta && cuenta.status === 'ABIERTA' ? (cuenta.amountCent - cuenta.paidCent) / 100 : 0,
    contadoSinDevolver: restante.porMedio.map((m) => ({ method: m.method, amount: m.cent / 100 })),
    cuenta, contadoPorMedioCent: restante.porMedio.map((m) => ({ method: m.method, cent: m.cent })),
    hayTurnoAbierto: !!turno, tieneDevoluciones: venta.saleReturns.length > 0,
    comprobante: doc ? { numero: doc.fullNumber, estado: doc.status, esEnsayo: doc.isTrial } : null,
    antiguedad: avisoAntiguedad(diaLocal(zona, venta.completedAt ?? new Date()), diaLocal(zona, new Date())),
  }
}
