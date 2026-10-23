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
