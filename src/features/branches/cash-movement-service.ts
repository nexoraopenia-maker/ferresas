import { Prisma } from '@/generated/prisma/client'
import { BusinessError } from '@/lib/errors'
import { P2002_UNIQUE } from '@/lib/prisma-errors'
import { puede } from '@/lib/puede'
import { requireBranch, type TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { redondearCentimos } from '@/lib/dinero'
import { efectivoEsperado, totalesDelTurno } from './cash-service'
import {
  ETIQUETA_CATEGORIA, REFERENCIA_OBLIGATORIA_DESDE, alcanza, excedeEfectivo, exigeReferencia, mensajeSinPermiso, permisoRequerido, puedeAnular, referenciaSuficiente,
  CATEGORIA_COMPENSACION, type CategoriaDeMovimiento, type TipoMovimiento,
} from './cash-movement-reglas'
import type { AnularMovimientoCajaInput, RegistrarMovimientoCajaInput } from './cash-movement-schemas'
import { bloquearTurno } from './queries'

/**
 * Movimientos manuales de caja (F6.3a): ingresos y egresos de EFECTIVO dentro del turno ABIERTO. Diseño: ver docs/ARCHITECTURE.md.
 *
 *  · Permisos (cada uno basta por sí solo): `caja.movimientos` para gastos menores y «otro» hasta el tope; `caja.ajuste` para todo lo demás.
 *  · El turno se BLOQUEA antes de escribir (`bloquearTurno`), igual que los abonos: si su cierre está en marcha, esta operación espera, lo ve
 *    cerrado y se niega. Nada se cuela en un turno que ya congeló sus totales; un turno cerrado no se modifica nunca.
 *  · Un egreso que supera el efectivo esperado NO se bloquea: se pide confirmación expresa (`confirmaExceso`) y queda marcado en el registro y en la
 *    auditoría. El aviso NO dice cuánto espera el sistema (el arqueo es a ciegas): solo que lo supera.
 *  · Idempotente por `idempotencyKey`: reintentar devuelve el mismo movimiento.
 */

const num = (v: unknown): number => Number(v ?? 0)
const cent = (v: unknown): number => Math.round(num(v) * 100)
const invalido = (m: string) => new BusinessError('INVALID_DOCUMENT', m)
const OPCIONES_TX = { maxWait: 15_000, timeout: 30_000 } as const

export interface MovimientoCaja {
  id: string
  cashSessionId: string
  kind: TipoMovimiento
  category: CategoriaDeMovimiento
  /** EFECTIVO salvo en la compensación de un abono que no fue en efectivo. */
  method: string
  amount: number
  description: string
  reference: string | null
  /** El egreso superó el efectivo esperado y se confirmó expresamente. */
  exceededExpected: boolean
  createdAt: string
  replayed: boolean
}

const seleccion = {
  id: true, cashSessionId: true, kind: true, category: true, method: true, amount: true, description: true, reference: true, exceededExpected: true, createdAt: true, idempotencyKey: true,
} as const

function deFila(m: { id: string; cashSessionId: string; kind: TipoMovimiento; category: CategoriaDeMovimiento; method: string; amount: Prisma.Decimal; description: string; reference: string | null; exceededExpected: boolean; createdAt: Date }, replayed: boolean): MovimientoCaja {
  return {
    id: m.id, cashSessionId: m.cashSessionId, kind: m.kind, category: m.category, method: m.method, amount: num(m.amount), description: m.description, reference: m.reference,
    exceededExpected: m.exceededExpected, createdAt: m.createdAt.toISOString(), replayed,
  }
}

const permisosDe = (ctx: TenantContext) => ({ movimientos: puede(ctx, 'caja.movimientos'), ajuste: puede(ctx, 'caja.ajuste') })

async function porClave(t: TenantPrismaClient, clave: string): Promise<MovimientoCaja | null> {
  const previo = await t.cashMovement.findFirst({ where: { idempotencyKey: clave }, select: seleccion })
  return previo ? deFila(previo, true) : null
}

/** Registra un ingreso o egreso manual en el turno abierto de la sucursal de quien lo registra. */
export async function registrarMovimientoCaja(db: TenantPrismaClient, ctx: TenantContext, input: RegistrarMovimientoCajaInput): Promise<MovimientoCaja> {
  const montoCent = Math.round(input.amount * 100)
  const tiene = permisosDe(ctx)
  const requerido = permisoRequerido(input.category, montoCent)
  if (!alcanza(tiene, requerido)) throw new BusinessError('FORBIDDEN_ROLE', mensajeSinPermiso(input.category, montoCent, tiene))
  if (exigeReferencia(input.kind, montoCent) && !referenciaSuficiente(input.reference)) {
    throw invalido(`Un egreso de más de S/ ${REFERENCIA_OBLIGATORIA_DESDE.toFixed(2)} necesita una referencia: el número del comprobante o del recibo.`)
  }
  const ya = await porClave(db, input.idempotencyKey)
  if (ya) return ya
  const branchId = requireBranch(ctx)

  try {
    return await db.$transaction(async (tx) => {
      const t = tx as unknown as TenantPrismaClient
      const abierto = await t.cashSession.findFirst({ where: { branchId, status: 'ABIERTA' }, select: { id: true, openingAmount: true } })
      if (!abierto) throw new BusinessError('CASH_REQUIRED', 'Para registrar un movimiento de caja hace falta un turno abierto en esta sucursal. Abre la caja primero.')
      // Si el cierre de este turno ya empezó, espera aquí y lo ve cerrado.
      if ((await bloquearTurno(t, abierto.id)).status !== 'ABIERTA') throw new BusinessError('CASH_REQUIRED', 'El turno de caja ya se cerró: abre uno nuevo para registrar el movimiento.')
      const repetido = await porClave(t, input.idempotencyKey)
      if (repetido) return repetido

      let excede = false
      if (input.kind === 'EGRESO') {
        const esperado = efectivoEsperado(num(abierto.openingAmount), await totalesDelTurno(t, abierto.id))
        excede = excedeEfectivo(input.kind, montoCent, Math.round(esperado * 100))
        if (excede && !input.confirmaExceso) {
          throw new BusinessError('CASH_EXCEEDS_EXPECTED', 'Este egreso es mayor que el efectivo que el sistema espera en el cajón. Si el dinero sí está, confírmalo y quedará marcado en la auditoría.')
        }
      }
      const m = await t.cashMovement.create({
        data: {
          tenantId: ctx.tenantId, branchId, cashSessionId: abierto.id, kind: input.kind, category: input.category,
          amount: new Prisma.Decimal((montoCent / 100).toFixed(2)), description: input.description, reference: input.reference?.trim() || null,
          exceededExpected: excede, userId: ctx.userId, idempotencyKey: input.idempotencyKey,
        },
        select: seleccion,
      })
      await t.auditLog.create({
        data: {
          tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role, action: 'caja.movimiento', entityType: 'CashMovement', entityId: m.id, reason: input.description,
          after: {
            tipo: input.kind, categoria: ETIQUETA_CATEGORIA[input.category], monto: montoCent / 100, referencia: input.reference?.trim() || null, turno: abierto.id,
            permiso: requerido, superoElEfectivoEsperado: excede,
          },
          impersonationId: ctx.impersonationId ?? null,
        },
      })
      return deFila(m, false)
    }, OPCIONES_TX)
  } catch (e) {
    // Dos envíos simultáneos con la misma clave: la base corta al segundo y se devuelve el del primero.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === P2002_UNIQUE) {
      const ganador = await porClave(db, input.idempotencyKey)
      if (ganador) return ganador
    }
    throw e
  }
}

/** Anula un movimiento MIENTRAS SU TURNO SIGA ABIERTO (un turno cerrado no se modifica). Nunca borra: queda quién, cuándo y por qué. */
export async function anularMovimientoCaja(db: TenantPrismaClient, ctx: TenantContext, input: AnularMovimientoCajaInput): Promise<{ id: string; voidedAt: string }> {
  const tiene = permisosDe(ctx)
  if (!tiene.movimientos && !tiene.ajuste) throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para anular movimientos de caja.')
  return db.$transaction(async (tx) => {
    const t = tx as unknown as TenantPrismaClient
    const previo = await t.cashMovement.findFirst({ where: { id: input.movementId }, select: { cashSessionId: true } })
    if (!previo) throw new BusinessError('NOT_FOUND', 'El movimiento no existe.')
    // El turno primero: si su cierre está en marcha, se espera y se ve cerrado.
    if ((await bloquearTurno(t, previo.cashSessionId)).status !== 'ABIERTA') {
      throw invalido('El turno de caja de este movimiento ya cerró y un turno cerrado no se modifica: haz el ajuste como un movimiento de hoy (corrección de arqueo).')
    }
    const m = await t.cashMovement.findFirst({ where: { id: input.movementId }, select: { id: true, kind: true, category: true, amount: true, userId: true, voidedAt: true } })
    if (!m) throw new BusinessError('NOT_FOUND', 'El movimiento no existe.')
    if (m.voidedAt) throw invalido('Este movimiento ya está anulado.')
    if (m.category === CATEGORIA_COMPENSACION) throw invalido('Esta compensación nació de anular un abono: no se anula a mano. El abono ya está anulado y su dinero salió de la caja.')
    if (!puedeAnular({ tiene, esAutor: m.userId === ctx.userId, categoria: m.category, montoCent: cent(m.amount) })) {
      throw new BusinessError('FORBIDDEN_ROLE', 'Solo quien registró el movimiento (si era de su alcance) o quien administra la caja puede anularlo.')
    }
    const ahora = new Date()
    await t.cashMovement.update({ where: { id: m.id }, data: { voidedAt: ahora, voidedById: ctx.userId, voidReason: input.reason }, select: { id: true } })
    await t.auditLog.create({
      data: {
        tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role, action: 'caja.movimiento_anulado', entityType: 'CashMovement', entityId: m.id, reason: input.reason,
        before: { tipo: m.kind, categoria: ETIQUETA_CATEGORIA[m.category], monto: redondearCentimos(num(m.amount)) },
        impersonationId: ctx.impersonationId ?? null,
      },
    })
    return { id: m.id, voidedAt: ahora.toISOString() }
  }, OPCIONES_TX)
}

export interface CompensacionDeAbono {
  movementId: string
  /** El turno ABIERTO donde quedó registrada. */
  cashSessionId: string
  /** Salió del cajón (el abono fue en efectivo) o solo se registró (otro medio). */
  efectivo: boolean
}

/**
 * Compensa en caja la anulación de un abono de un turno YA CERRADO (F6.3b), dentro de la transacción `t` de `anularAbono`, SIN comprobar permisos:
 * quien lo llama ya exigió `credito.castigar`. El turno cerrado NO se toca: se registra un EGRESO `COMPENSACION_ABONO` en el turno abierto de la
 * sucursal del abono, ligado al abono y al turno que corrige.
 *  · Abono en efectivo → el egreso sale del cajón de hoy (baja el efectivo esperado). Si deja el esperado en negativo NO se bloquea la anulación: se
 *    marca `exceededExpected` y queda en la auditoría.
 *  · Abono por otro medio (Yape, transferencia…) → se registra con ese medio y NO mueve el efectivo.
 * Sin turno abierto en esa sucursal se niega (`CASH_REQUIRED`): la compensación tiene que quedar en algún cajón.
 */
export async function compensarAbonoEn(
  t: TenantPrismaClient,
  ctx: TenantContext,
  p: { paymentId: string; branchId: string; method: string; amount: number; turnoCerradoId: string; motivo: string },
): Promise<CompensacionDeAbono> {
  const abierto = await t.cashSession.findFirst({ where: { branchId: p.branchId, status: 'ABIERTA' }, select: { id: true, openingAmount: true } })
  if (!abierto) {
    throw new BusinessError('CASH_REQUIRED', 'Este abono es de un turno de caja que ya cerró: su anulación se compensa con un egreso en la caja abierta de hoy y no hay ninguna abierta en la sucursal del abono. Abre la caja y vuelve a intentarlo.')
  }
  if ((await bloquearTurno(t, abierto.id)).status !== 'ABIERTA') {
    throw new BusinessError('CASH_REQUIRED', 'La caja de hoy se cerró mientras tanto: abre una nueva y vuelve a intentarlo.')
  }
  const efectivo = p.method === 'EFECTIVO'
  const montoCent = Math.round(p.amount * 100)
  const excede = efectivo && excedeEfectivo('EGRESO', montoCent, Math.round(efectivoEsperado(num(abierto.openingAmount), await totalesDelTurno(t, abierto.id)) * 100))
  const m = await t.cashMovement.create({
    data: {
      tenantId: ctx.tenantId, branchId: p.branchId, cashSessionId: abierto.id, kind: 'EGRESO', category: CATEGORIA_COMPENSACION, method: p.method as never,
      amount: new Prisma.Decimal((montoCent / 100).toFixed(2)),
      description: `Compensación del abono anulado: ${p.motivo}`.slice(0, 200),
      exceededExpected: excede, relatedSessionId: p.turnoCerradoId, relatedPaymentId: p.paymentId, userId: ctx.userId,
      // Un abono se anula una sola vez: la clave derivada de él es única y estable.
      idempotencyKey: `compensacion-abono:${p.paymentId}`,
    },
    select: { id: true },
  })
  await t.auditLog.create({
    data: {
      tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role, action: 'caja.movimiento', entityType: 'CashMovement', entityId: m.id, reason: p.motivo,
      after: {
        tipo: 'EGRESO', categoria: ETIQUETA_CATEGORIA[CATEGORIA_COMPENSACION], monto: montoCent / 100, medio: p.method, abono: p.paymentId, turnoCorregido: p.turnoCerradoId, turno: abierto.id,
        permiso: 'credito.castigar', salioDelCajon: efectivo, superoElEfectivoEsperado: excede,
      },
      impersonationId: ctx.impersonationId ?? null,
    },
  })
  return { movementId: m.id, cashSessionId: abierto.id, efectivo }
}
