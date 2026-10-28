import { Prisma } from '@/generated/prisma/client'
import { BusinessError } from '@/lib/errors'
import { P2002_UNIQUE } from '@/lib/prisma-errors'
import { exigir } from '@/lib/puede'
import type { TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { bloquearTurno, cargarSucursalOperativa, serieDe } from '@/features/branches/queries'
import { darDeBajaCuentaEn } from '@/features/credito/credito-service'
import { applyStockMovement } from '@/features/inventory/stock-service'
import { emitirNotaCreditoTotalEn, prepararNotaCreditoTotal } from '@/features/invoicing/service'
import { claimNextNumber, ensureCounter } from '@/features/pos/sale-service'
import type { AnularOdevolverVentaInput } from './schemas'
import { aDiezmilesimas, acumulado } from './parcial'
import {
  CODIGO_NOTA, ESTADO_FINAL, ETIQUETA_TIPO, efectivoDelCajon, necesitaCaja, pagadoNeto, planDeComprobante, planDeCredito, productosDadosDeBaja, validarReembolsos,
  type PlanComprobante, type ReembolsoValido,
} from './reglas'

/**
 * Anular o devolver una venta COMPLETA (F6.1). Una sola transacción. Diseño y decisiones: docs/F6.1-DISENO.md.
 *
 *  · Permiso: `ventas.anular` y nada más. La nota de crédito (`emitirNotaCreditoTotalEn`) y la baja de la cuenta por cobrar
 *    (`darDeBajaCuentaEn`) son núcleos SIN permiso propio: los autoriza esta operación.
 *  · Orden de bloqueos (el del crédito y el cierre de caja): venta → cliente → turno de caja → productos → stock.
 *  · El dinero devuelto sale del turno ABIERTO de hoy; un turno cerrado no se modifica.
 *  · El stock se repone completo (movimiento DEVOLUCION_CLIENTE: no toca el costo promedio ni queda «costo pendiente»).
 *  · Idempotente por `idempotencyKey`.
 */

const num = (v: unknown): number => Number(v ?? 0)
const noExiste = () => new BusinessError('NOT_FOUND', 'La venta no existe.')
const invalido = (m: string) => new BusinessError('INVALID_DOCUMENT', m)
const OPCIONES_TX = { maxWait: 15_000, timeout: 30_000 } as const

export interface ResultadoDevolucion {
  returnId: string
  number: string
  kind: 'ANULACION' | 'DEVOLUCION'
  saleId: string
  saleNumber: string
  status: 'ANULADA' | 'DEVUELTA'
  creditNote: { id: string; fullNumber: string } | null
  refunds: { mode: 'CAJA' | 'EXTERNO' | 'SIN_SALIDA'; method: string | null; amount: number }[]
  receivableVoidedAmount: number
  stockLines: number
  replayed: boolean
}

// ─── Evaluación (se hace fuera de la transacción para fallar rápido, y otra vez dentro, ya con la venta bloqueada) ───────

async function leerVenta(t: TenantPrismaClient, saleId: string) {
  return t.sale.findFirst({
    where: { id: saleId },
    select: {
      id: true, number: true, status: true, branchId: true, warehouseId: true, total: true, customerId: true,
      items: {
        orderBy: { id: 'asc' },
        select: {
          id: true, productId: true, variantId: true, quantity: true, lineTotal: true, nameSnapshot: true, unitCost: true, taxRate: true, returnedQuantity: true,
          presentationId: true, enteredQuantity: true, presentationFactor: true, presentationName: true,
          product: { select: { name: true, trackStock: true, deletedAt: true } },
        },
      },
      payments: { select: { method: true, amount: true, change: true } },
      receivable: {
        select: {
          id: true, status: true, amount: true, paidAmount: true, customerId: true,
          allocations: { select: { amount: true, customerPayment: { select: { voidedAt: true, method: true, receivedAt: true } } } },
        },
      },
      taxDocuments: { where: { documentType: { in: ['BOLETA', 'FACTURA'] } }, take: 1, select: { id: true, status: true, isTrial: true, fullNumber: true } },
    },
  })
}

type Venta = NonNullable<Awaited<ReturnType<typeof leerVenta>>>

interface Evaluacion {
  venta: Venta
  reembolsos: ReembolsoValido[]
  paidNetCent: number
  planDoc: PlanComprobante
  planCredito: ReturnType<typeof planDeCredito>
  lineasConStock: Venta['items']
}

async function evaluar(t: TenantPrismaClient, input: AnularOdevolverVentaInput): Promise<Evaluacion> {
  const venta = await leerVenta(t, input.saleId)
  if (!venta) throw noExiste()
  if (venta.status !== 'COMPLETADA') {
    throw invalido(
      venta.status === 'ANULADA' || venta.status === 'DEVUELTA'
        ? `La venta ${venta.number} ya está ${venta.status.toLowerCase()}.`
        : `Solo se anula o devuelve una venta completada; la ${venta.number} está ${venta.status.toLowerCase()}.`,
    )
  }

  // Con devoluciones parciales ya hechas, lo que falta se devuelve por líneas (F6.2): una devolución total contaría dos veces lo devuelto.
  if (venta.items.some((i) => num(i.returnedQuantity) > 0)) {
    throw invalido(`La venta ${venta.number} ya tiene devoluciones parciales: devuelve lo que falta con «Devolver productos» (no se puede anular ni devolver entera).`)
  }

  // Productos con control de stock dados de baja: no pueden recibir el stock de vuelta.
  const baja = productosDadosDeBaja(venta.items.map((i) => ({ nombre: i.product.name, trackStock: i.product.trackStock, dadoDeBaja: i.product.deletedAt !== null })))
  if (baja.length > 0) {
    throw invalido(`No se puede devolver el stock de ${baja.map((n) => `«${n}»`).join(', ')}: ${baja.length === 1 ? 'el producto está dado de baja' : 'los productos están dados de baja'}. Reactívalo${baja.length === 1 ? '' : 's'} para poder reingresar el stock y vuelve a intentar.`)
  }

  const abonos = (venta.receivable?.allocations ?? []).filter((a) => a.customerPayment.voidedAt === null)
    .map((a) => ({ fecha: a.customerPayment.receivedAt.toISOString().slice(0, 10), monto: num(a.amount), metodo: a.customerPayment.method }))
  const planCredito = planDeCredito(venta.receivable ? { status: venta.receivable.status, amount: num(venta.receivable.amount), paidAmount: num(venta.receivable.paidAmount) } : null, abonos)
  if (planCredito.accion === 'BLOQUEAR') throw new BusinessError('CREDIT_HAS_PAYMENTS', planCredito.mensaje)

  const doc = venta.taxDocuments[0]
  const planDoc = planDeComprobante(doc ? { estado: doc.status, isTrial: doc.isTrial, numero: doc.fullNumber } : null, input.kind)
  if (planDoc.accion === 'BLOQUEAR') throw invalido(planDoc.mensaje)

  const pagado = pagadoNeto(venta.payments.map((p) => ({ method: p.method, amount: num(p.amount), change: num(p.change) })))
  const r = validarReembolsos(input.refunds?.map((x) => ({ mode: x.mode, method: x.method ?? null, amount: x.amount, reference: x.reference ?? null })), pagado)
  if (!r.ok) throw invalido(r.mensaje)

  return { venta, reembolsos: r.reembolsos, paidNetCent: pagado.netoCent, planDoc, planCredito, lineasConStock: venta.items.filter((i) => i.product.trackStock) }
}

export async function turnoAbiertoDe(t: TenantPrismaClient, branchId: string): Promise<string> {
  const turno = await t.cashSession.findFirst({ where: { branchId, status: 'ABIERTA' }, select: { id: true } })
  if (!turno) throw new BusinessError('CASH_REQUIRED', 'Para devolver dinero en efectivo desde el cajón hace falta un turno de caja abierto en la sucursal de la venta. Abre la caja, o elige devolverlo por otro medio.')
  return turno.id
}

function resultadoDe(r: {
  id: string; number: string; kind: 'ANULACION' | 'DEVOLUCION'; saleId: string; creditNote: { id: string; fullNumber: string } | null
  receivableVoidedAmount: Prisma.Decimal; sale: { number: string }; refunds: { mode: 'CAJA' | 'EXTERNO' | 'SIN_SALIDA'; method: string | null; amount: Prisma.Decimal }[]; _count: { items: number }
}, replayed: boolean): ResultadoDevolucion {
  return {
    returnId: r.id, number: r.number, kind: r.kind, saleId: r.saleId, saleNumber: r.sale.number, status: ESTADO_FINAL[r.kind], creditNote: r.creditNote,
    refunds: r.refunds.map((x) => ({ mode: x.mode, method: x.method, amount: num(x.amount) })), receivableVoidedAmount: num(r.receivableVoidedAmount),
    stockLines: r._count.items, replayed,
  }
}

const seleccionDevolucion = {
  id: true, number: true, kind: true, saleId: true, receivableVoidedAmount: true,
  sale: { select: { number: true } }, creditNote: { select: { id: true, fullNumber: true } },
  refunds: { select: { mode: true, method: true, amount: true } }, _count: { select: { items: true } },
} as const

async function devolucionPorClave(t: TenantPrismaClient, input: AnularOdevolverVentaInput): Promise<ResultadoDevolucion | null> {
  const previa = await t.saleReturn.findFirst({ where: { idempotencyKey: input.idempotencyKey }, select: seleccionDevolucion })
  if (!previa) return null
  if (previa.saleId !== input.saleId) throw invalido('Esa clave de operación ya se usó con otra venta.')
  return resultadoDe(previa as never, true)
}

// ─── La operación ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export async function anularOdevolverVenta(db: TenantPrismaClient, ctx: TenantContext, input: AnularOdevolverVentaInput): Promise<ResultadoDevolucion> {
  exigir(ctx, 'ventas.anular')
  const ya = await devolucionPorClave(db, input)
  if (ya) return ya

  // Antes de abrir la transacción: fallar rápido con el mensaje claro, y dejar listo lo que no puede crearse DENTRO de ella
  // (los contadores: crearlos dentro haría chocar a dos personas a la vez).
  const previa = await evaluar(db, input)
  if (necesitaCaja(previa.reembolsos)) await turnoAbiertoDe(db, previa.venta.branchId)
  const motivoNota = `${ETIQUETA_TIPO[input.kind]} de la venta ${previa.venta.number}: ${input.reason}`.slice(0, 250)
  if (previa.planDoc.accion === 'EMITIR_NOTA') await prepararNotaCreditoTotal(db, ctx, { saleId: input.saleId, reasonCode: previa.planDoc.codigo, reasonDescription: motivoNota })
  // El contador va al final: un rechazo anterior no deja nada creado.
  const sucursal = await cargarSucursalOperativa(db, previa.venta.branchId)
  const serie = serieDe(sucursal, 'RETURN')
  await ensureCounter(db, ctx.tenantId, sucursal.id, 'RETURN', serie.series, serie.prefix)

  try {
    return await db.$transaction(async (tx) => {
      const t = tx as unknown as TenantPrismaClient

      // 1. La venta, bloqueada. Dos devoluciones a la vez: la segunda espera, la ve ya devuelta y recibe el mismo resultado (misma clave) o un error claro.
      await t.sale.update({ where: { id: input.saleId }, data: { updatedAt: new Date() }, select: { id: true } })
      const repetida = await devolucionPorClave(t, input)
      if (repetida) return repetida
      const ev = await evaluar(t, input)
      const { venta } = ev

      const n = await claimNextNumber(t, ctx.tenantId, 'RETURN', serie.series)
      const number = `${n.prefix}${n.series}-${String(n.correlativo).padStart(8, '0')}`
      const motivo = `${ETIQUETA_TIPO[input.kind]} ${number}: ${input.reason}`.slice(0, 250)

      // 2. Crédito: sin abonos, la cuenta se cancela y la deuda del cliente baja (bloquea al cliente primero).
      let canceladoCent = 0
      if (ev.planCredito.accion === 'CANCELAR_CUENTA') {
        const baja = await darDeBajaCuentaEn(t, ctx, { receivableId: venta.receivable!.id, motivo }, { devolucion: number })
        canceladoCent = Math.round(baja.saldoCastigado * 100)
        // Un abono pudo entrar entre la comprobación y el bloqueo del cliente: la baja castigaría solo el saldo. Aquí no se perdona
        // lo ya abonado: se deshace todo (la transacción entera) y se pide anular el abono primero.
        if (canceladoCent !== ev.planCredito.montoCent) {
          throw new BusinessError('CREDIT_HAS_PAYMENTS', 'Mientras tanto se registró un abono en esta venta fiada. Anula ese abono primero y vuelve a intentarlo.')
        }
      }

      // 3. Caja: el efectivo sale del turno abierto AHORA (bloqueado: si su cierre ya empezó, esto espera y lo ve cerrado). Los reembolsos por
      //    otro medio anotan el turno abierto, si lo hay, para que el informe del cierre los cuente; se bloquea por la misma razón.
      let turnoId: string | null = null
      if (ev.reembolsos.length > 0) {
        const abierto = await t.cashSession.findFirst({ where: { branchId: venta.branchId, status: 'ABIERTA' }, select: { id: true } })
        if (abierto && (await bloquearTurno(t, abierto.id)).status === 'ABIERTA') turnoId = abierto.id
        if (necesitaCaja(ev.reembolsos) && !turnoId) throw new BusinessError('CASH_REQUIRED', 'Para devolver dinero en efectivo desde el cajón hace falta un turno de caja abierto en la sucursal de la venta. Abre la caja, o elige devolverlo por otro medio.')
      }

      // 4. Comprobante: la nota de crédito total nace en ESTA transacción (o la marca de ensayo).
      let nota: { id: string; fullNumber: string } | null = null
      if (ev.planDoc.accion === 'EMITIR_NOTA') {
        const emitida = await emitirNotaCreditoTotalEn(t, ctx, { saleId: input.saleId, reasonCode: ev.planDoc.codigo, reasonDescription: motivoNota })
        nota = { id: emitida.id, fullNumber: emitida.fullNumber }
      } else if (ev.planDoc.accion === 'MARCAR_ENSAYO') {
        await t.taxDocument.updateMany({ where: { saleId: input.saleId, isTrial: true }, data: { voidedAt: new Date(), voidReason: motivo } })
      }

      // 5. El registro de la devolución, sus líneas y sus reembolsos.
      const registro = await t.saleReturn.create({
        data: {
          tenantId: ctx.tenantId, saleId: input.saleId, kind: input.kind, number, reason: input.reason, isFull: true, userId: ctx.userId,
          creditNoteId: nota?.id ?? null, saleTotal: num(venta.total), returnTotal: num(venta.total), paidNet: ev.paidNetCent / 100, receivableVoidedAmount: canceladoCent / 100,
          idempotencyKey: input.idempotencyKey,
        },
        select: { id: true },
      })
      await t.saleReturnItem.createMany({
        data: venta.items.map((i) => {
          // La línea entera, con la MISMA partición base/IGV que usan la venta y las devoluciones parciales.
          const todo = acumulado({ totalCent: Math.round(num(i.lineTotal) * 100), vendidaM: aDiezmilesimas(num(i.quantity)), tasa: num(i.taxRate) }, aDiezmilesimas(num(i.quantity)))
          return {
            tenantId: ctx.tenantId, returnId: registro.id, saleItemId: i.id, quantity: num(i.quantity), amount: num(i.lineTotal),
            enteredQuantity: i.enteredQuantity === null ? null : num(i.enteredQuantity), presentationName: i.presentationName,
            subtotal: todo.baseCent / 100, taxAmount: todo.igvCent / 100, taxRate: num(i.taxRate), destination: (i.product.trackStock ? 'STOCK' : 'SIN_STOCK') as 'STOCK' | 'SIN_STOCK',
          }
        }),
      })
      // El tope por línea: lo vendido queda devuelto por completo.
      for (const i of venta.items) {
        await t.saleItem.update({ where: { id: i.id }, data: { returnedQuantity: num(i.quantity), returnedAmount: num(i.lineTotal) }, select: { id: true } })
      }
      if (ev.reembolsos.length > 0) {
        await t.saleReturnRefund.createMany({
          data: ev.reembolsos.map((r) => ({ tenantId: ctx.tenantId, returnId: registro.id, mode: r.mode, method: r.method, amount: r.amount, reference: r.reference, cashSessionId: turnoId })),
        })
      }

      // 6. Stock: TODO vuelve (productos por id, para no cruzar bloqueos con otra operación). No toca el costo promedio.
      for (const l of [...ev.lineasConStock].sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : a.id < b.id ? -1 : 1))) {
        const mov = await applyStockMovement(t, ctx, {
          type: 'ENTRADA',
          productId: l.productId,
          variantId: l.variantId ?? null,
          warehouseId: venta.warehouseId,
          quantity: num(l.quantity),
          source: 'MANUAL',
          traza: l.presentationId && l.enteredQuantity !== null && l.presentationFactor !== null
            ? { presentationId: l.presentationId, enteredQuantity: l.enteredQuantity.toString(), factor: l.presentationFactor.toString() }
            : null,
          reason: `${ETIQUETA_TIPO[input.kind]} de la venta ${venta.number} (${number})`,
        }, 'VENTA', undefined, 'DEVOLUCION_CLIENTE')
        await t.stockMovement.update({ where: { id: mov.movementId }, data: { referenceType: 'DEVOLUCION', referenceId: registro.id, unitCost: l.unitCost, unitCostApplied: l.unitCost }, select: { id: true } })
      }

      // 7. La venta cambia de estado: sale de las ventas completadas de todos los reportes.
      const ahora = new Date()
      await t.sale.update({ where: { id: input.saleId }, data: { status: ESTADO_FINAL[input.kind], voidedAt: ahora, voidReason: input.reason }, select: { id: true } })

      const accionDeAuditoria = input.kind === 'ANULACION' ? { action: 'venta.anulada' } : { action: 'venta.devuelta' }
      await t.auditLog.create({
        data: {
          tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role,
          ...accionDeAuditoria, entityType: 'Sale', entityId: input.saleId, reason: input.reason,
          before: { estado: 'COMPLETADA' },
          after: {
            devolucion: number, venta: venta.number, estado: ESTADO_FINAL[input.kind], total: num(venta.total), pagadoNeto: ev.paidNetCent / 100,
            reembolsos: ev.reembolsos.map((r) => ({ modo: r.mode, medio: r.method, monto: r.amount })), efectivoDelCajon: efectivoDelCajon(ev.reembolsos),
            notaDeCredito: nota?.fullNumber ?? null, comprobante: ev.planDoc.accion, cuentaCancelada: canceladoCent / 100,
            lineasRepuestas: ev.lineasConStock.length, codigoNota: ev.planDoc.accion === 'EMITIR_NOTA' ? CODIGO_NOTA[input.kind] : null,
          },
          impersonationId: ctx.impersonationId ?? null,
        },
      })

      const guardada = await t.saleReturn.findFirstOrThrow({ where: { id: registro.id }, select: seleccionDevolucion })
      return resultadoDe(guardada as never, false)
    }, OPCIONES_TX)
  } catch (e) {
    // Reintento (o dos a la vez) con la misma clave, o dos devoluciones de la misma venta: la base corta a la segunda y su transacción se deshizo.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === P2002_UNIQUE) {
      const ganadora = await devolucionPorClave(db, input)
      if (ganadora) return ganadora
      throw invalido('Esa venta ya fue anulada o devuelta.')
    }
    throw e
  }
}

// ─── Lo que la pantalla necesita saber ANTES de devolver ────────────────────────────────────────────────────────────────────────

export interface DiagnosticoDevolucion {
  puede: boolean
  /** Por qué NO se puede, en español claro y accionable (`code` distingue abonos, cola fiscal, producto dado de baja…). */
  bloqueo: { code: string; mensaje: string } | null
  /** Lo que el cliente pagó de verdad (sin lo fiado ni el vuelto). */
  pagadoNeto: number
  /** El reembolso propuesto: el dinero vuelve por donde entró. */
  reembolsos: ReembolsoValido[]
  /** ¿Hay un turno de caja abierto en la sucursal de la venta? Sin él, el efectivo no puede salir del cajón. */
  hayTurnoAbierto: boolean
  /** Si la venta tiene un comprobante real vivo, se emitirá su nota de crédito total (01 al anular, 06 al devolver). */
  nota: { comprobante: string } | null
  /** Si el comprobante es de ensayo, se marca anulado (sin nota). */
  comprobanteDeEnsayo: boolean
  /** Deuda del cliente que se cancelará (venta fiada sin abonos), en soles. */
  cuentaACancelar: number
}

/**
 * Lo mismo que comprobará `anularOdevolverVenta`, sin ejecutar nada: sirve para enseñar el botón, el reembolso propuesto y el motivo exacto
 * por el que una venta no se puede devolver. Exige `ventas.anular` (quien no puede devolver no necesita este análisis).
 */
export async function diagnosticarDevolucion(db: TenantPrismaClient, ctx: TenantContext, saleId: string): Promise<DiagnosticoDevolucion> {
  exigir(ctx, 'ventas.anular')
  const vacio: DiagnosticoDevolucion = { puede: false, bloqueo: null, pagadoNeto: 0, reembolsos: [], hayTurnoAbierto: false, nota: null, comprobanteDeEnsayo: false, cuentaACancelar: 0 }
  try {
    const ev = await evaluar(db, { saleId, kind: 'DEVOLUCION', reason: 'diagnóstico', idempotencyKey: '00000000-0000-4000-8000-000000000000' })
    const turno = await db.cashSession.findFirst({ where: { branchId: ev.venta.branchId, status: 'ABIERTA' }, select: { id: true } })
    return {
      puede: true, bloqueo: null, pagadoNeto: ev.paidNetCent / 100, reembolsos: ev.reembolsos, hayTurnoAbierto: !!turno,
      nota: ev.planDoc.accion === 'EMITIR_NOTA' ? { comprobante: ev.venta.taxDocuments[0]!.fullNumber } : null,
      comprobanteDeEnsayo: ev.planDoc.accion === 'MARCAR_ENSAYO',
      cuentaACancelar: ev.planCredito.accion === 'CANCELAR_CUENTA' ? ev.planCredito.montoCent / 100 : 0,
    }
  } catch (e) {
    if (e instanceof BusinessError && e.code !== 'FORBIDDEN_ROLE' && e.code !== 'TENANT_MISMATCH') return { ...vacio, bloqueo: { code: e.code, mensaje: e.message } }
    throw e
  }
}
