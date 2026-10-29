/**
 * El consolidado del día por sucursal (F6.8c): une los turnos de TODAS las cajas de cada sucursal. Lo ve solo quien tiene `caja.consolidado` (dueño y administrador de fábrica; fuera del PIN).
 *
 *  · «El día» es el día del negocio (su zona horaria) en que se ABRIÓ el turno. Un turno que cruza la medianoche cuenta en el día en que abrió, completo, para que dos días nunca se repartan un mismo turno.
 *  · Un turno CERRADO aporta la foto congelada al cerrar (`closingBreakdown`) y su arqueo (esperado, contado, diferencia). Uno ABIERTO aporta el desglose de lo que lleva y se marca como abierto, sin arqueo
 *    (el arqueo es a ciegas hasta que se cuenta). Uno cerrado antes de F6.8b no tiene foto: se lista, con sus totales de arqueo, y se avisa que no entra en el detalle por medio de pago.
 *  · Solo sucursales que la persona alcanza (el cliente aislado ya filtra por `branchIds`).
 *  · Ninguna cifra de costo, margen o valor de inventario.
 */
import { BusinessError } from '@/lib/errors'
import { exigir } from '@/lib/puede'
import { diaLocal, medianoche } from '@/lib/periodos'
import { generarCsv, type CeldaCsv } from '@/lib/csv-export'
import type { TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { desgloseDelTurno } from './cierre-desglose-datos'
import { ETIQUETA_METODO, METODOS_REPORTE, sumarDesgloses, type DesgloseCierre } from './cierre-desglose'

const num = (v: unknown): number => Number(v ?? 0)
const cent = (n: number) => Math.round(n * 100) / 100

export interface TurnoConsolidado {
  id: string
  caja: string | null
  cajero: string
  estado: 'ABIERTA' | 'CERRADA'
  abiertoEn: string
  cerradoEn: string | null
  fondo: number
  /** Solo en turnos cerrados. */
  esperado: number | null
  contado: number | null
  diferencia: number | null
  /** Cerrado antes de F6.8b: no hay foto por medio de pago. */
  sinDesglose: boolean
  /** Número de ventas y total vendido del turno (con o sin foto). */
  ventas: { cantidad: number; total: number }
}

export interface SucursalConsolidada {
  branchId: string
  sucursal: string
  turnos: TurnoConsolidado[]
  /** La suma de los desgloses de los turnos que tienen foto (o que siguen abiertos). */
  total: DesgloseCierre
  abiertos: number
  cerrados: number
  /** Suma de los arqueos de los turnos cerrados. */
  arqueo: { esperado: number; contado: number; diferencia: number }
  sinDesglose: number
}

export interface ConsolidadoDelDia {
  fecha: string
  zonaHoraria: string
  sucursales: SucursalConsolidada[]
  /** Todas las sucursales juntas. */
  general: { total: DesgloseCierre; abiertos: number; cerrados: number; arqueo: { esperado: number; contado: number; diferencia: number }; sinDesglose: number }
}

const FECHA = /^(\d{4})-(\d{2})-(\d{2})$/

/** `YYYY-MM-DD` válido o `null`. */
export function leerFecha(texto: string | null | undefined): { y: number; m: number; d: number; iso: string } | null {
  const m = FECHA.exec(texto ?? '')
  if (!m) return null
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3])
  const f = new Date(Date.UTC(y, mo - 1, d))
  if (f.getUTCFullYear() !== y || f.getUTCMonth() !== mo - 1 || f.getUTCDate() !== d) return null
  return { y, m: mo, d, iso: `${m[1]}-${m[2]}-${m[3]}` }
}

export async function consolidadoDelDia(db: TenantPrismaClient, ctx: TenantContext, fecha?: string | null, ahora: Date = new Date()): Promise<ConsolidadoDelDia> {
  exigir(ctx, 'caja.consolidado')
  const tenant = await db.tenant.findFirstOrThrow({ select: { timezone: true } })
  const dia = fecha ? leerFecha(fecha) : leerFecha(diaLocal(tenant.timezone, ahora))
  if (!dia) throw new BusinessError('INVALID_DOCUMENT', 'La fecha no es válida: usa el formato AAAA-MM-DD.')
  const desde = medianoche(tenant.timezone, dia.y, dia.m, dia.d), hasta = medianoche(tenant.timezone, dia.y, dia.m, dia.d + 1)

  const turnos = await db.cashSession.findMany({
    where: { openedAt: { gte: desde, lt: hasta } },
    orderBy: [{ openedAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true, branchId: true, status: true, openedAt: true, closedAt: true, openingAmount: true, expectedAmount: true, countedAmount: true, difference: true, salesCount: true, salesTotal: true,
      closingBreakdown: true, register: { select: { name: true } }, openedBy: { select: { name: true, email: true } },
    },
  })
  const sucursales = await db.branch.findMany({ where: { id: { in: [...new Set(turnos.map((t) => t.branchId))] } }, select: { id: true, name: true } })
  const nombreSuc = new Map(sucursales.map((b) => [b.id, b.name]))

  const porSucursal = new Map<string, { turno: TurnoConsolidado; desglose: DesgloseCierre | null }[]>()
  for (const t of turnos) {
    const cerrado = t.status === 'CERRADA'
    const foto = cerrado ? (t.closingBreakdown as DesgloseCierre | null) : await desgloseDelTurno(db, t.id)
    const fila: TurnoConsolidado = {
      id: t.id, caja: t.register?.name ?? null, cajero: t.openedBy.name ?? t.openedBy.email, estado: t.status,
      abiertoEn: t.openedAt.toISOString(), cerradoEn: t.closedAt?.toISOString() ?? null, fondo: num(t.openingAmount),
      esperado: cerrado ? num(t.expectedAmount) : null, contado: cerrado ? num(t.countedAmount) : null, diferencia: cerrado ? num(t.difference) : null,
      sinDesglose: foto === null,
      ventas: foto ? { cantidad: foto.ventas.cantidad, total: foto.ventas.total } : { cantidad: t.salesCount, total: num(t.salesTotal) },
    }
    const lista = porSucursal.get(t.branchId) ?? []
    lista.push({ turno: fila, desglose: foto })
    porSucursal.set(t.branchId, lista)
  }

  const resumen = (xs: { turno: TurnoConsolidado; desglose: DesgloseCierre | null }[]) => {
    const cerrados = xs.filter((x) => x.turno.estado === 'CERRADA')
    return {
      total: sumarDesgloses(xs.flatMap((x) => (x.desglose ? [x.desglose] : []))),
      abiertos: xs.length - cerrados.length, cerrados: cerrados.length,
      arqueo: {
        esperado: cent(cerrados.reduce((s, x) => s + (x.turno.esperado ?? 0), 0)), contado: cent(cerrados.reduce((s, x) => s + (x.turno.contado ?? 0), 0)),
        diferencia: cent(cerrados.reduce((s, x) => s + (x.turno.diferencia ?? 0), 0)),
      },
      sinDesglose: xs.filter((x) => x.turno.sinDesglose).length,
    }
  }
  const salida: SucursalConsolidada[] = [...porSucursal.entries()]
    .map(([branchId, xs]) => ({ branchId, sucursal: nombreSuc.get(branchId) ?? branchId, turnos: xs.map((x) => x.turno), ...resumen(xs) }))
    .sort((a, b) => a.sucursal.localeCompare(b.sucursal, 'es'))
  return { fecha: dia.iso, zonaHoraria: tenant.timezone, sucursales: salida, general: resumen([...porSucursal.values()].flat()) }
}

/** El mismo consolidado en CSV (Excel es-PE): una fila por turno y los subtotales por sucursal y general. Sin costos. */
export async function exportarConsolidadoCsv(db: TenantPrismaClient, ctx: TenantContext, fecha?: string | null, ahora?: Date): Promise<{ nombre: string; contenido: string }> {
  const c = await consolidadoDelDia(db, ctx, fecha, ahora)
  const M = (monto: number | null): CeldaCsv => (monto === null ? null : { monto })
  const filas: CeldaCsv[][] = []
  for (const s of c.sucursales) {
    for (const t of s.turnos) filas.push([s.sucursal, t.caja ?? '—', t.cajero, t.estado === 'ABIERTA' ? 'Abierto' : 'Cerrado', t.ventas.cantidad, M(t.ventas.total), M(t.fondo), M(t.esperado), M(t.contado), M(t.diferencia), t.sinDesglose ? 'Sin detalle por medio' : ''])
    filas.push([s.sucursal, 'TOTAL SUCURSAL', '', `${s.cerrados} cerrado(s), ${s.abiertos} abierto(s)`, s.total.ventas.cantidad, M(s.total.ventas.total), null, M(s.arqueo.esperado), M(s.arqueo.contado), M(s.arqueo.diferencia), ''])
    for (const m of METODOS_REPORTE) if (s.total.ventasPorMetodo[m].operaciones > 0) filas.push([s.sucursal, `Ventas · ${ETIQUETA_METODO[m]}`, '', '', s.total.ventasPorMetodo[m].operaciones, M(s.total.ventasPorMetodo[m].monto), null, null, null, null, ''])
  }
  filas.push(['TODAS LAS SUCURSALES', 'TOTAL', '', `${c.general.cerrados} cerrado(s), ${c.general.abiertos} abierto(s)`, c.general.total.ventas.cantidad, M(c.general.total.ventas.total), null, M(c.general.arqueo.esperado), M(c.general.arqueo.contado), M(c.general.arqueo.diferencia), ''])
  for (const m of METODOS_REPORTE) if (c.general.total.ventasPorMetodo[m].operaciones > 0) filas.push(['TODAS LAS SUCURSALES', `Ventas · ${ETIQUETA_METODO[m]}`, '', '', c.general.total.ventasPorMetodo[m].operaciones, M(c.general.total.ventasPorMetodo[m].monto), null, null, null, null, ''])
  return {
    nombre: `consolidado-caja-${c.fecha}.csv`,
    contenido: generarCsv(['Sucursal', 'Caja / concepto', 'Cajero', 'Estado', 'Ventas', 'Monto vendido', 'Fondo', 'Esperado', 'Contado', 'Diferencia', 'Nota'], filas),
  }
}
