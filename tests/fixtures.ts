import { prisma } from '@/lib/prisma'

/**
 * Fixtures compartidos de la suite.
 *
 * Existe porque al introducir multi-sucursal, los ocho ficheros de pruebas
 * que creaban un almacén a mano quedaron rotos a la vez: `Warehouse.branchId`
 * es NOT NULL. Repetir el bloque de creación en cada uno garantizaría que el
 * próximo campo obligatorio vuelva a romper los ocho.
 */

/**
 * Casa matriz de un tenant de prueba.
 *
 * `seriesNumber` por defecto 1 a propósito: es el que produce las series
 * "001", "B001" y "F001" que las pruebas ya daban por buenas, así que los
 * números esperados no cambian al pasar a multi-sucursal.
 */
export async function crearSucursal(
  tenantId: string,
  opts: {
    code?: string
    name?: string
    establishmentCode?: string
    seriesNumber?: number
    isDefault?: boolean
  } = {},
) {
  return prisma.branch.create({
    data: {
      tenantId,
      code: opts.code ?? 'PRINCIPAL',
      name: opts.name ?? 'Casa matriz',
      establishmentCode: opts.establishmentCode ?? '0000',
      seriesNumber: opts.seriesNumber ?? 1,
      isDefault: opts.isDefault ?? true,
      // Completa por defecto: con la facturación real habilitada la sucursal necesita dirección y ubigeo.
      address: 'Av. Prueba 123, Lima',
      ubigeo: '150101',
    },
  })
}

/** Da acceso a un usuario a una sucursal. Sin esto, `requireBranch` lo frena. */
export async function asignarSucursal(
  tenantId: string,
  userId: string,
  branchId: string,
) {
  return prisma.userBranch.create({ data: { tenantId, userId, branchId } })
}

/**
 * Sucursal + almacén, el combo que casi todas las pruebas necesitan.
 * Devuelve ambos para que la prueba pueda seguir usando `w.id` como antes.
 */
export async function crearSucursalConAlmacen(
  tenantId: string,
  opts: {
    almacenCode?: string
    almacenName?: string
    seriesNumber?: number
    branchCode?: string
    establishmentCode?: string
  } = {},
) {
  const branch = await crearSucursal(tenantId, {
    code: opts.branchCode,
    seriesNumber: opts.seriesNumber,
    establishmentCode: opts.establishmentCode,
  })
  const warehouse = await prisma.warehouse.create({
    data: {
      tenantId,
      branchId: branch.id,
      code: opts.almacenCode ?? 'PRIN',
      name: opts.almacenName ?? 'Principal',
      isDefault: true,
    },
  })
  return { branch, warehouse }
}

/**
 * El turno de caja PROPIO de una persona en una sucursal (F6.8b). Desde esta fase todo cobro, abono, pago, movimiento o devolución que mueve dinero entra al turno abierto de QUIEN
 * lo ejecuta, y una persona solo puede tener un turno abierto en toda la cuenta: cada «cajero» de una prueba que cobra necesita el suyo, y dos cajeros de la misma sucursal usan
 * cajas distintas. Reutiliza la «Caja principal» de la sucursal (o la crea) y, con `caja`, abre en otra de nombre `caja`. Devuelve el id del turno.
 */
export async function abrirTurno(
  tenantId: string,
  userId: string,
  branchId: string,
  opts: { fondo?: number; caja?: string } = {},
): Promise<string> {
  // Una caja LIBRE (sin turno abierto) de la sucursal: dos cajeros nunca comparten caja. Si no hay, se crea la siguiente.
  const cajas = await prisma.cashRegister.findMany({
    where: { tenantId, branchId, deletedAt: null }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, name: true, sessions: { where: { status: 'ABIERTA' }, select: { id: true }, take: 1 } },
  })
  let caja = opts.caja ? cajas.find((c) => c.name === opts.caja) : cajas.find((c) => c.sessions.length === 0)
  if (!caja) caja = { ...(await prisma.cashRegister.create({ data: { tenantId, branchId, name: opts.caja ?? (cajas.length === 0 ? 'Caja principal' : `Caja ${cajas.length + 1}`) }, select: { id: true, name: true } })), sessions: [] }
  const s = await prisma.cashSession.create({
    data: { tenantId, branchId, registerId: caja.id, openedById: userId, status: 'ABIERTA', openingAmount: opts.fondo ?? 0 },
    select: { id: true },
  })
  return s.id
}

/**
 * `{ registerId }` de la primera caja LIBRE de la sucursal (sin turno abierto), para abrir un turno con `openCashSession` cuando ya hay más de una caja: el servicio exige elegir.
 * Sin ninguna caja libre devuelve `{}` y el servicio decide (crea la principal si no hay cajas, o se rechaza si todas están ocupadas).
 */
export async function cajaLibre(tenantId: string, branchId: string): Promise<{ registerId?: string }> {
  const c = await prisma.cashRegister.findFirst({
    where: { tenantId, branchId, deletedAt: null, isActive: true, sessions: { none: { status: 'ABIERTA' } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true },
  })
  return c ? { registerId: c.id } : {}
}

/**
 * El id de una caja viva de la sucursal (la crea con el nombre «Caja principal» si no hay ninguna). Desde F6.8d `cash_sessions.registerId` es obligatorio: las pruebas que insertan un turno
 * a mano con `prisma.cashSession.create` le ponen esta caja. No abre turno ni mira si la caja está ocupada.
 */
export async function cajaDe(tenantId: string, branchId: string): Promise<string> {
  const c = await prisma.cashRegister.findFirst({ where: { tenantId, branchId, deletedAt: null }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true } })
  if (c) return c.id
  return (await prisma.cashRegister.create({ data: { tenantId, branchId, name: 'Caja principal' }, select: { id: true } })).id
}
