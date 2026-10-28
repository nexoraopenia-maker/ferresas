import type { InventoryCountItemStatus, InventoryCountStatus, UnitType } from '@/generated/prisma/enums'
import { BusinessError } from '@/lib/errors'
import { puede } from '@/lib/puede'
import type { TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { generarCsv, type CeldaCsv } from '@/lib/csv-export'
import { MAX_LINEAS_CONTEO } from './conteo-schemas'
import { SELECCION_CONTEO, invalido, noExiste, r4 } from './conteo-service'
import { puedeVerRevision, revisionDelConteo, type LineaRevision } from './conteo-revision'
import { ETIQUETA_ALCANCE, ETIQUETA_ALERTA, ETIQUETA_ESTADO, ETIQUETA_ESTADO_LINEA, ETIQUETA_MODO } from './conteo-ui'

/**
 * Los documentos de la toma de inventario (F6.5c): el ACTA imprimible y el CSV. SOLO LECTURA (el CSV deja una línea de auditoría).
 *
 *  · Los ve quien revisa las diferencias (`stock.ajustar` o `conteo.gestionar`); quien solo cuenta, no: llevan lo que decía el sistema.
 *  · Costos y valores SOLO con `productos.ver_costo`: sin ese permiso no existen en el acta ni en el CSV (ni como columna vacía).
 *  · Las cifras son las de la revisión: lo aprobado muestra lo que se evaluó al aprobarlo; el resto, la medición contra el kardex a la hora de contar.
 */

const PAGINA = 200
const LIMITE_ACTA_DETALLE = 3_000

async function todasLasLineas(db: TenantPrismaClient, ctx: TenantContext, countId: string, tope: number) {
  const lineas: LineaRevision[] = []
  let cursor: string | undefined
  let conteo
  let conCostos = false
  for (;;) {
    const r = await revisionDelConteo(db, ctx, { countId, limite: PAGINA, cursor })
    conteo = r.conteo; conCostos = r.conCostos
    lineas.push(...r.lineas)
    if (!r.siguiente || lineas.length >= tope) return { conteo, conCostos, lineas: lineas.slice(0, tope), completo: !r.siguiente || lineas.length <= tope }
    cursor = r.siguiente
  }
}

// ─── Acta ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface FilaActa {
  nombre: string
  sku: string
  unidad: UnitType
  estado: InventoryCountItemStatus
  contado: number | null
  sistemaAlContar: number | null
  diferencia: number | null
  nota: string | null
  /** AUSENTE sin `productos.ver_costo`. */
  valorDiferencia?: number | null
}

export interface ActaConteo {
  numero: string
  estado: InventoryCountStatus
  emisor: { nombre: string; razonSocial: string | null; ruc: string | null; direccion: string | null }
  sucursal: string
  almacen: string
  alcance: string
  modo: string
  notas: string | null
  zonaHoraria: string
  locale: string
  fechas: { creado: string; iniciado: string | null; cerrado: string | null; aplicado: string | null }
  responsables: { creo: string; inicio: string | null; cerro: string | null; aplico: string | null; contadores: string[] }
  conCostos: boolean
  /** Solo las líneas con diferencia, rechazadas o por recontar, salvo que se pida el detalle completo. */
  lineas: FilaActa[]
  detalleCompleto: boolean
  /** El detalle completo se cortó en 3.000 líneas (el CSV lleva todas). */
  truncado: boolean
  resumen: {
    lineas: number
    sinContar: number
    sinDiferencia: number
    conDiferencia: number
    aprobadas: number
    rechazadas: number
    porRecontar: number
    /** De lo APROBADO, en unidades. */
    sobrantes: number
    faltantes: number
    netas: number
    /** AUSENTES sin `productos.ver_costo`. */
    valorSobrantes?: number
    valorFaltantes?: number
    sinCosto?: number
  }
}

const PERSONA = { select: { name: true, email: true } } as const
const nombreDe = (p: { name: string | null; email: string } | null): string | null => (p ? p.name ?? p.email : null)

export async function getActaConteo(db: TenantPrismaClient, ctx: TenantContext, countId: string, opts: { detalleCompleto?: boolean } = {}): Promise<ActaConteo> {
  if (!puedeVerRevision(ctx)) throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para ver las diferencias de una toma de inventario.')
  const c = await db.inventoryCount.findFirst({
    where: { id: countId },
    select: { ...SELECCION_CONTEO, appliedAt: true, createdBy: PERSONA, startedBy: PERSONA, closedBy: PERSONA, appliedBy: PERSONA, branch: { select: { name: true } } },
  })
  if (!c) throw noExiste()
  if (c.status !== 'EN_REVISION' && c.status !== 'APLICADO') throw invalido(`El acta se emite con la toma de inventario cerrada: la ${c.number} ${c.status === 'CANCELADO' ? 'está cancelada' : 'todavía está en conteo'}.`)
  const t = await db.tenant.findFirstOrThrow({ select: { name: true, legalName: true, taxId: true, address: true, timezone: true, locale: true } })
  const { lineas: todas, conCostos } = await todasLasLineas(db, ctx, countId, MAX_LINEAS_CONTEO)
  const contadores = await db.inventoryCountEntry.findMany({ where: { countId, voidedAt: null }, distinct: ['userId'], select: { user: PERSONA } })

  const aprobadas = todas.filter((l) => l.estado === 'APROBADO')
  const con = (l: LineaRevision) => l.diferencia !== null && l.diferencia !== 0
  const resumen: ActaConteo['resumen'] = {
    lineas: todas.length, sinContar: todas.filter((l) => l.estado === 'PENDIENTE').length,
    sinDiferencia: todas.filter((l) => l.contado !== null && l.diferencia === 0).length, conDiferencia: todas.filter(con).length,
    aprobadas: aprobadas.length, rechazadas: todas.filter((l) => l.estado === 'RECHAZADO').length, porRecontar: todas.filter((l) => l.estado === 'RECONTAR').length,
    sobrantes: r4(aprobadas.filter((l) => (l.diferencia ?? 0) > 0).reduce((a, l) => a + (l.diferencia ?? 0), 0)),
    faltantes: r4(-aprobadas.filter((l) => (l.diferencia ?? 0) < 0).reduce((a, l) => a + (l.diferencia ?? 0), 0)),
    netas: r4(aprobadas.reduce((a, l) => a + (l.diferencia ?? 0), 0)),
  }
  if (conCostos) {
    resumen.valorSobrantes = Math.round(aprobadas.filter((l) => (l.diferencia ?? 0) > 0).reduce((a, l) => a + (l.costos?.valorDiferencia ?? 0), 0) * 100) / 100
    resumen.valorFaltantes = Math.round(aprobadas.filter((l) => (l.diferencia ?? 0) < 0).reduce((a, l) => a + (l.costos?.valorDiferencia ?? 0), 0) * 100) / 100
    resumen.sinCosto = aprobadas.filter((l) => con(l) && l.costos?.costoPromedio === null).length
  }

  const detalle = !!opts.detalleCompleto
  const visibles = detalle ? todas : todas.filter((l) => con(l) || l.estado === 'RECHAZADO' || l.estado === 'RECONTAR')
  const recorte = visibles.slice(0, detalle ? LIMITE_ACTA_DETALLE : MAX_LINEAS_CONTEO)
  return {
    numero: c.number, estado: c.status,
    emisor: { nombre: t.name, razonSocial: t.legalName, ruc: t.taxId, direccion: t.address },
    sucursal: c.branch.name, almacen: c.warehouse.name, alcance: ETIQUETA_ALCANCE[c.scope], modo: ETIQUETA_MODO[c.mode], notas: c.notes, zonaHoraria: t.timezone, locale: t.locale,
    fechas: { creado: c.createdAt.toISOString(), iniciado: c.startedAt?.toISOString() ?? null, cerrado: c.closedAt?.toISOString() ?? null, aplicado: c.appliedAt?.toISOString() ?? null },
    responsables: { creo: nombreDe(c.createdBy) ?? '—', inicio: nombreDe(c.startedBy), cerro: nombreDe(c.closedBy), aplico: nombreDe(c.appliedBy), contadores: contadores.map((x) => nombreDe(x.user) ?? '—').sort() },
    conCostos, detalleCompleto: detalle, truncado: detalle && visibles.length > recorte.length, resumen,
    lineas: recorte.map((l): FilaActa => ({
      nombre: l.nombre, sku: l.sku, unidad: l.unidad, estado: l.estado, contado: l.contado, sistemaAlContar: l.sistemaAlContar, diferencia: l.diferencia, nota: l.notaRevision,
      ...(conCostos ? { valorDiferencia: l.costos?.valorDiferencia ?? null } : {}),
    })),
  }
}

// ─── CSV ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** El detalle completo del conteo en CSV (Excel es-PE), con las mismas reglas de costos que la revisión. Deja una línea de auditoría. */
export async function exportarConteoCsv(db: TenantPrismaClient, ctx: TenantContext, countId: string): Promise<{ nombre: string; contenido: string; filas: number }> {
  if (!puedeVerRevision(ctx)) throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para ver las diferencias de una toma de inventario.')
  const c = await db.inventoryCount.findFirst({ where: { id: countId }, select: { id: true, number: true, status: true } })
  if (!c) throw noExiste()
  if (c.status === 'BORRADOR' || c.status === 'CANCELADO') throw invalido(`La toma de inventario ${c.number} ${c.status === 'BORRADOR' ? 'todavía no se inició' : 'está cancelada'}: no hay nada que exportar.`)
  const { lineas, conCostos } = await todasLasLineas(db, ctx, countId, MAX_LINEAS_CONTEO)

  const cabecera = ['Producto', 'SKU', 'Unidad', 'Estado', 'Contado', 'Sistema al contar', 'Diferencia', 'Porcentaje', 'Movimientos posteriores', 'Stock actual', 'Alertas', 'Nota']
  if (conCostos) cabecera.push('Costo promedio', 'Valor de la diferencia')
  const filas: CeldaCsv[][] = lineas.map((l) => [
    l.nombre, l.sku, l.unidad, ETIQUETA_ESTADO_LINEA[l.estado], l.contado, l.sistemaAlContar, l.diferencia, l.porcentaje === null ? null : Math.round(l.porcentaje * 10_000) / 100,
    l.contado === null ? null : l.movimientosDesdeContar, l.stockActual, l.alertas.map((a) => ETIQUETA_ALERTA[a]).join(' | '), l.notaRevision ?? '',
    ...(conCostos ? [l.costos?.costoPromedio == null ? null : { monto: l.costos.costoPromedio }, l.costos?.valorDiferencia == null ? null : { monto: l.costos.valorDiferencia }] : []),
  ])
  await db.auditLog.create({
    data: {
      tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role, action: 'reporte.exportado', entityType: 'InventoryCount', entityId: c.id,
      after: { reporte: 'conteo', numero: c.number, estado: ETIQUETA_ESTADO[c.status], filas: filas.length, conCostos } as never, impersonationId: ctx.impersonationId ?? null,
    },
  })
  return { nombre: `conteo-${c.number}.csv`, contenido: generarCsv(cabecera, filas), filas: filas.length }
}

/** ¿Puede esta persona ver los valores del acta/CSV? (la regla en un solo sitio, para las pantallas). */
export const verValoresDelConteo = (ctx: TenantContext): boolean => puede(ctx, 'productos.ver_costo')
