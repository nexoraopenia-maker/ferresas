/**
 * Lo que comprueban `scripts/verificar-turnos-abiertos.ts` (ANTES del paso 1 de F6.8) y `scripts/verificar-turnos-sin-caja.ts` (ANTES del paso 2). Solo lectura: reciben el cliente base
 * (revisan todos los negocios) y nunca escriben.
 */
export interface UsuarioConVariosTurnos {
  tenantId: string
  userId: string
  nombre: string
  turnos: { id: string; branchId: string; abiertoEn: Date }[]
}

interface LectorDeTurnos {
  cashSession: {
    findMany(args: {
      where: { status: 'ABIERTA' } | { registerId: null }
      select: { id: true; tenantId: true; branchId: true; status?: true; openedById?: true; openedAt?: true; openedBy?: { select: { name: true } } }
      orderBy?: unknown
    }): Promise<{ id: string; tenantId: string; branchId: string; status?: string; openedById?: string; openedAt?: Date; openedBy?: { name: string } }[]>
  }
}

/**
 * Personas con MÁS DE UN turno abierto (en cualquier sucursal): el índice «un turno abierto por persona» de la migración de F6.8 no se puede crear mientras existan. Hay que cerrar esos
 * turnos a mano antes de desplegar.
 */
export async function usuariosConVariosTurnosAbiertos(db: LectorDeTurnos): Promise<UsuarioConVariosTurnos[]> {
  const abiertos = await db.cashSession.findMany({
    where: { status: 'ABIERTA' }, select: { id: true, tenantId: true, branchId: true, openedById: true, openedAt: true, openedBy: { select: { name: true } } }, orderBy: [{ openedAt: 'asc' }],
  })
  const porPersona = new Map<string, UsuarioConVariosTurnos>()
  for (const t of abiertos) {
    const k = `${t.tenantId}|${t.openedById}`
    const u = porPersona.get(k) ?? { tenantId: t.tenantId, userId: t.openedById!, nombre: t.openedBy?.name ?? '(sin nombre)', turnos: [] }
    u.turnos.push({ id: t.id, branchId: t.branchId, abiertoEn: t.openedAt! })
    porPersona.set(k, u)
  }
  return [...porPersona.values()].filter((u) => u.turnos.length > 1)
}

/** Turnos que todavía no tienen caja asignada (`registerId` nulo): el paso 2 de F6.8 (NOT NULL) no se puede aplicar mientras existan. */
export async function turnosSinCaja(db: LectorDeTurnos): Promise<{ id: string; tenantId: string; branchId: string; status: string | undefined }[]> {
  const filas = await db.cashSession.findMany({ where: { registerId: null }, select: { id: true, tenantId: true, branchId: true, status: true } })
  return filas.map((f) => ({ id: f.id, tenantId: f.tenantId, branchId: f.branchId, status: f.status }))
}
