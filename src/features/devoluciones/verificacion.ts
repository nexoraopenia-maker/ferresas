/** Lo que comprueba `scripts/verificar-ventas-anuladas.ts` y fija su prueba. Solo lectura; recibe el cliente base (revisa todos los negocios). */
export interface VentaQueRompeElCheck { tenantId: string; number: string; status: string; voidedAt: Date | null; voidReason: string | null }

interface LectorDeVentas {
  sale: { findMany(args: { where: { status: { in: ('ANULADA' | 'DEVUELTA')[] } }; select: { tenantId: true; number: true; status: true; voidedAt: true; voidReason: true } }): Promise<VentaQueRompeElCheck[]> }
}

/** Ventas ANULADA/DEVUELTA sin `voidedAt`, o con el motivo nulo o en blanco: justo lo que el CHECK `sales_anulada_devuelta_chk` rechaza. */
export async function ventasQueRompenElCheck(db: LectorDeVentas): Promise<VentaQueRompeElCheck[]> {
  const filas = await db.sale.findMany({ where: { status: { in: ['ANULADA', 'DEVUELTA'] } }, select: { tenantId: true, number: true, status: true, voidedAt: true, voidReason: true } })
  return filas.filter((f) => f.voidedAt === null || f.voidReason === null || f.voidReason.trim() === '')
}
