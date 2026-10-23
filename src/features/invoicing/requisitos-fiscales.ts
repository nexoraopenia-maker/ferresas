import { validarRuc } from '@/lib/documentos'
import { BusinessError } from '@/lib/errors'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { distritoExiste } from '@/features/ubigeo/service'

/**
 * Requisitos para EMITIR con facturación real.
 *
 * Solo aplican a un negocio con la facturación real HABILITADA (y que no sea
 * demo): mientras el interruptor esté apagado nada de esto bloquea, porque
 * nada sale hacia ningún proveedor. Así activar el requisito no rompe a quien
 * emite hoy.
 *
 * Qué se exige de la SUCURSAL desde la que se emite: dirección completa y un
 * ubigeo que exista en el catálogo del INEI (o, mientras ese catálogo no esté
 * cargado, que tenga el formato de 6 dígitos). Y del NEGOCIO: un RUC válido.
 */

export interface ResultadoRequisitos {
  /** ¿Se exigen? Falso si la facturación real está apagada o es una demo. */
  aplica: boolean
  faltantes: string[]
}

export async function faltantesParaEmitir(db: TenantPrismaClient, branchId: string): Promise<ResultadoRequisitos> {
  const t = await db.tenant.findFirst({ select: { isDemo: true, realBillingEnabledAt: true, taxId: true } })
  if (!t || t.isDemo || !t.realBillingEnabledAt) return { aplica: false, faltantes: [] }

  const faltantes: string[] = []
  if (!t.taxId || !validarRuc(t.taxId).valido) faltantes.push('el RUC del negocio (válido)')

  const b = await db.branch.findFirst({ where: { id: branchId }, select: { name: true, address: true, ubigeo: true } })
  if (!b) {
    faltantes.push('la sucursal desde la que se emite')
  } else {
    if (!b.address || b.address.trim().length < 8) faltantes.push(`la dirección completa de la sucursal «${b.name}»`)
    if (!b.ubigeo || !/^\d{6}$/.test(b.ubigeo)) faltantes.push(`el ubigeo de la sucursal «${b.name}»`)
    else if ((await distritoExiste(b.ubigeo)) === false) faltantes.push(`un ubigeo válido en la sucursal «${b.name}» (${b.ubigeo} no está en el catálogo del INEI)`)
  }
  return { aplica: true, faltantes }
}

/** Lanza si faltan requisitos; dice exactamente cuáles. */
export async function exigirRequisitosFiscales(db: TenantPrismaClient, branchId: string): Promise<void> {
  const r = await faltantesParaEmitir(db, branchId)
  if (r.faltantes.length > 0) {
    throw new BusinessError(
      'INVALID_DOCUMENT',
      `Para emitir con facturación electrónica real falta: ${r.faltantes.join('; ')}. Complétalo en Sucursales o en el perfil del negocio.`,
      { faltantes: r.faltantes.length },
    )
  }
}
