import { registrarCodigosProducto } from './codigos'
import { Prisma } from '@/generated/prisma/client'
import { BusinessError } from '@/lib/errors'
import { type TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { redondear } from '@/lib/quantity'
import { createHash } from 'node:crypto'
import { puede } from '@/lib/puede'
import { mapColumns, normalizeUnit, parseAmount, parseCsv } from './csv'

/**
 * Importación masiva de catálogo.
 *
 * ─── DOS FASES, SIEMPRE ──────────────────────────────────────────────────
 *
 * `analyzeImport` no escribe NADA: valida fila por fila y devuelve el
 * resultado para que la persona lo revise. `commitImport` escribe.
 *
 * No es prudencia excesiva. Un catálogo de ferretería trae dos mil filas
 * exportadas de un Excel que lleva años pasando de mano en mano: precios en
 * blanco, unidades inventadas, SKU repetidos. Escribir primero y avisar
 * después dejaría el catálogo a medio cargar y sin forma de saber qué
 * entró — y la segunda importación duplicaría lo que sí entró.
 */

export const MAX_FILAS = 5000

export type EstadoFila = 'crear' | 'actualizar' | 'error'

export interface FilaAnalizada {
  /** Número de línea en el archivo, contando la cabecera. Para el mensaje. */
  linea: number
  estado: EstadoFila
  /** Problemas que impiden importar la fila. */
  errores: string[]
  /** Cosas que se corrigieron o asumieron, sin impedir la importación. */
  avisos: string[]
  /** Producto existente con el que se emparejó, si lo hay. */
  coincidePor: 'barcode' | 'sku' | 'name' | null
  datos: {
    name: string
    sku: string | null
    barcode: string | null
    qrCode: string | null
    /** `null` = el archivo no dice nada: al actualizar NO se toca el valor actual. */
    unitType: string | null
    salePrice: number
    /** `null` = sin dato en el archivo. Nunca se interpreta como 0 al actualizar. */
    costPrice: number | null
    stock: number
    minStock: number | null
  }
}

export interface AnalisisImport {
  filas: FilaAnalizada[]
  resumen: {
    total: number
    crear: number
    actualizar: number
    error: number
  }
  /** Cabeceras del archivo que no se reconocieron. */
  columnasIgnoradas: string[]
  columnasDetectadas: string[]
  delimitador: string
  /** Problemas del archivo entero, no de una fila. */
  bloqueos: string[]
  limitePlan: {
    maxProducts: number | null
    actuales: number
    seCrearian: number
    excede: boolean
  }
}

/**
 * SKU generado para filas que no traen ni código de barras ni SKU.
 *
 * Se deriva del NOMBRE con un hash, no de la fecha. Con un SKU basado en
 * `Date.now()`, reimportar el mismo archivo generaba otro SKU distinto y el
 * producto se duplicaba — y en una ferretería eso afecta justo a lo que más
 * se vende a granel: clavos, cable, tubería, nada de eso viene etiquetado de
 * fábrica.
 *
 * Al derivarlo del nombre, el mismo archivo produce el mismo SKU y el
 * emparejamiento funciona sin más.
 */
export function skuDesdeNombre(name: string): string {
  const normalizado = name
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
  const hash = createHash('sha1').update(normalizado).digest('hex').slice(0, 8).toUpperCase()
  return `IMP-${hash}`
}

/** Clave de comparación de nombres, insensible a tildes y mayúsculas. */
function claveNombre(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
}

function num(d: Prisma.Decimal | number | null | undefined): number {
  if (d === null || d === undefined) return 0
  return typeof d === 'number' ? d : d.toNumber()
}

/**
 * Analiza el archivo sin escribir nada.
 *
 * El emparejamiento con productos existentes va por CÓDIGO DE BARRAS primero
 * y por SKU después. Ese orden importa: el código de barras lo pone el
 * fabricante y es el mismo en todo el mundo, mientras que el SKU lo inventa
 * cada negocio y puede haber cambiado entre exportaciones del Excel.
 */
export async function analyzeImport(
  db: TenantPrismaClient,
  ctx: TenantContext,
  contenido: string,
): Promise<AnalisisImport> {
  if (!puede(ctx, 'productos.crear')) {
    throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para importar catálogo.')
  }

  const bloqueos: string[] = []
  const tabla = parseCsv(contenido)
  const columnas = mapColumns(tabla.headers)

  if (tabla.rows.length === 0) {
    bloqueos.push('El archivo no tiene filas de datos, solo cabeceras.')
  }
  if (tabla.rows.length > MAX_FILAS) {
    bloqueos.push(
      `El archivo tiene ${tabla.rows.length} filas y el máximo por importación es ${MAX_FILAS}. Pártelo en varios.`,
    )
  }
  if (columnas.indices.name === undefined) {
    bloqueos.push(
      'No se encontró la columna del nombre. Debe llamarse «nombre», «producto» o «descripción».',
    )
  }
  if (columnas.indices.salePrice === undefined) {
    bloqueos.push(
      'No se encontró la columna del precio de venta. Debe llamarse «precio», «p. venta» o «pvp».',
    )
  }

  // El costo es información restringida: un archivo que lo trae solo lo
  // puede importar quien puede verlo. Se rechaza el archivo entero (y no la
  // columna en silencio) para que nadie crea que el costo quedó cargado.
  const puedeEditarPrecio = puede(ctx, 'productos.editar_precio')
  if (columnas.indices.costPrice !== undefined && !puede(ctx, 'productos.ver_costo')) {
    bloqueos.push(
      'El archivo trae una columna de costo y no tienes permiso para ver ni cargar costos. ' +
        'Quita esa columna e inténtalo de nuevo.',
    )
  }

  // --- Productos existentes, en UNA consulta ----------------------------
  // Traer el catálogo de golpe y cruzar en memoria. Con dos mil filas, una
  // consulta por fila serían dos mil viajes a la base.
  const existentes = bloqueos.length > 0 ? [] : await db.product.findMany({
    where: { deletedAt: null },
    select: { id: true, sku: true, barcode: true, name: true, salePrice: true },
  })
  const porBarcode = new Map(
    existentes.filter((p) => p.barcode).map((p) => [p.barcode!, p]),
  )
  const porSku = new Map(existentes.map((p) => [p.sku, p]))
  // Tercer nivel de emparejamiento: el NOMBRE. Es el único identificador
  // estable que tiene una fila sin código de barras ni SKU, y sin él cada
  // reimportación duplicaría todo el granel del catálogo.
  const porNombre = new Map(existentes.map((p) => [claveNombre(p.name), p]))

  const tenant = await db.tenant.findFirstOrThrow({
    select: {
      taxRate: true,
      plan: { select: { maxProducts: true } },
      subscription: { select: { plan: { select: { maxProducts: true } } } },
    },
  })
  const maxProducts =
    tenant.subscription?.plan?.maxProducts ?? tenant.plan?.maxProducts ?? null

  // --- Fila por fila ----------------------------------------------------
  const filas: FilaAnalizada[] = []
  // Duplicados DENTRO del archivo: sin esto, dos filas con el mismo SKU
  // pasarían las dos y la segunda sobreescribiría a la primera en silencio.
  const skusVistos = new Map<string, number>()
  const barcodesVistos = new Map<string, number>()
  const qrVistos = new Map<string, number>()

  const col = (fila: string[], campo: keyof typeof columnas.indices) => {
    const i = columnas.indices[campo]
    return i === undefined ? undefined : fila[i]
  }

  for (let f = 0; f < tabla.rows.length && bloqueos.length === 0; f++) {
    const fila = tabla.rows[f]!
    const linea = f + 2 // +1 por la cabecera, +1 porque los humanos cuentan desde 1
    const errores: string[] = []
    const avisos: string[] = []

    const name = (col(fila, 'name') ?? '').trim()
    if (name.length < 2) errores.push('El nombre está vacío o es demasiado corto.')
    if (name.length > 160) errores.push('El nombre pasa de 160 caracteres.')

    const salePrice = parseAmount(col(fila, 'salePrice'), 'money')
    if (salePrice === null) {
      errores.push('El precio de venta no es un número.')
    } else if (salePrice < 0) {
      errores.push('El precio de venta es negativo.')
    }

    const costPriceRaw = parseAmount(col(fila, 'costPrice'), 'money')
    if (col(fila, 'costPrice')?.trim() && costPriceRaw === null) {
      avisos.push('El costo no es un número; se ignora.')
    }
    const costPrice = costPriceRaw !== null && costPriceRaw >= 0 ? costPriceRaw : null

    if (salePrice !== null && costPrice !== null && costPrice > salePrice && costPrice > 0) {
      // No se bloquea: hay negocios que venden bajo costo para liquidar. Pero
      // es casi siempre un error de columnas invertidas, y conviene decirlo.
      avisos.push('El costo es mayor que el precio de venta. ¿Están cambiadas las columnas?')
    }

    const stockRaw = parseAmount(col(fila, 'stock'), 'quantity')
    if (col(fila, 'stock')?.trim() && stockRaw === null) {
      avisos.push('El stock no es un número; se deja en 0.')
    }
    const stock = stockRaw !== null && stockRaw >= 0 ? redondear(stockRaw) : 0
    if (stockRaw !== null && stockRaw < 0) {
      avisos.push('El stock era negativo; se deja en 0.')
    }

    const minRaw = parseAmount(col(fila, 'minStock'), 'quantity')
    const minStock = minRaw !== null && minRaw >= 0 ? redondear(minRaw) : null

    const unidadTexto = col(fila, 'unitType')
    let unitType = normalizeUnit(unidadTexto)
    if (unidadTexto?.trim() && unitType === null) {
      avisos.push(`No se reconoce la unidad «${unidadTexto.trim()}»; se ignora.`)
    }

    const limpiar = (v: string | undefined) => {
      const s = (v ?? '').trim()
      return s === '' ? null : s
    }
    const barcode = limpiar(col(fila, 'barcode'))
    const qrCode = limpiar(col(fila, 'qrCode'))
    const sku = limpiar(col(fila, 'sku'))

    // Duplicados dentro del archivo.
    if (barcode) {
      const antes = barcodesVistos.get(barcode)
      if (antes) errores.push(`Código de barras repetido (ya aparece en la línea ${antes}).`)
      else barcodesVistos.set(barcode, linea)
    }
    if (sku) {
      const antes = skusVistos.get(sku)
      if (antes) errores.push(`SKU repetido (ya aparece en la línea ${antes}).`)
      else skusVistos.set(sku, linea)
    }
    if (qrCode) {
      const antes = qrVistos.get(qrCode)
      if (antes) errores.push(`Código QR repetido (ya aparece en la línea ${antes}).`)
      else qrVistos.set(qrCode, linea)
    }

    /**
     * Emparejamiento en tres niveles, de más fiable a menos:
     *   1. código de barras — lo pone el fabricante, es el mismo en todo el mundo
     *   2. SKU — lo inventa el negocio, pero es explícito
     *   3. nombre — lo único que queda para el granel sin etiqueta
     *
     * El SKU generado también se prueba: al derivarse del nombre, una
     * reimportación lo reconstruye igual.
     */
    let coincidePor: FilaAnalizada['coincidePor'] = null
    let existente = barcode ? porBarcode.get(barcode) : undefined
    if (existente) coincidePor = 'barcode'

    if (!existente && sku) {
      existente = porSku.get(sku)
      if (existente) coincidePor = 'sku'
    }
    if (!existente && !barcode && !sku && name.length >= 2) {
      existente = porSku.get(skuDesdeNombre(name))
      if (existente) coincidePor = 'sku'
      if (!existente) {
        existente = porNombre.get(claveNombre(name))
        if (existente) coincidePor = 'name'
      }
    }

    if (existente && existente.name !== name) {
      avisos.push(`Renombra «${existente.name}» a «${name}».`)
    }
    if (existente && stock > 0) {
      // El stock NUNCA se sobreescribe al actualizar: ver commitImport.
      avisos.push('El stock del archivo se ignora: este producto ya existe.')
    }

    if (
      existente && salePrice !== null && !puedeEditarPrecio &&
      redondear(Number(existente.salePrice)) !== redondear(salePrice)
    ) {
      errores.push('Este producto ya existe y no tienes permiso para cambiar precios.')
    }

    filas.push({
      linea,
      estado: errores.length > 0 ? 'error' : existente ? 'actualizar' : 'crear',
      errores,
      avisos,
      coincidePor,
      datos: {
        name, sku, barcode, qrCode, unitType,
        salePrice: salePrice ?? 0,
        costPrice, stock, minStock,
      },
    })
  }

  const crear = filas.filter((f) => f.estado === 'crear').length
  const actualizar = filas.filter((f) => f.estado === 'actualizar').length
  const error = filas.filter((f) => f.estado === 'error').length

  const actuales = existentes.length
  const excede = maxProducts !== null && actuales + crear > maxProducts

  if (excede) {
    bloqueos.push(
      `Tu plan permite ${maxProducts} productos. Tienes ${actuales} y el archivo crearía ${crear} más. ` +
        'Mejora el plan o importa menos productos.',
    )
  }

  const detectadas = Object.keys(columnas.indices)

  return {
    filas,
    resumen: { total: filas.length, crear, actualizar, error },
    columnasIgnoradas: columnas.ignoradas,
    columnasDetectadas: detectadas,
    delimitador: tabla.delimiter,
    bloqueos,
    limitePlan: { maxProducts, actuales, seCrearian: crear, excede },
  }
}

export interface ResultadoImport {
  creados: number
  actualizados: number
  omitidos: number
}

/**
 * Escribe el resultado del análisis.
 *
 * ─── LO QUE NO HACE: TOCAR EL STOCK DE LO QUE YA EXISTE ──────────────────
 *
 * Al ACTUALIZAR un producto se cambian nombre, precios y mínimo, pero NUNCA
 * la cantidad en stock. Reimportar un Excel de hace tres semanas pondría el
 * inventario en los valores de entonces y borraría en silencio tres semanas
 * de entradas y salidas.
 *
 * El stock del archivo solo se usa al CREAR, y entra por el ledger como
 * movimiento INICIAL, igual que en el alta exprés: así `SUM(movimientos)`
 * sigue cuadrando con `Stock.quantity`.
 */
export async function commitImport(
  db: TenantPrismaClient,
  ctx: TenantContext,
  analisis: AnalisisImport,
  warehouseId: string,
  now: Date = new Date(),
): Promise<ResultadoImport> {
  if (!puede(ctx, 'productos.crear')) {
    throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para importar catálogo.')
  }

  if (analisis.bloqueos.length > 0) {
    throw new BusinessError('INVALID_DOCUMENT', analisis.bloqueos[0]!)
  }

  const importables = analisis.filas.filter((f) => f.estado !== 'error')
  if (importables.length === 0) {
    throw new BusinessError('INVALID_DOCUMENT', 'No hay ninguna fila importable.')
  }

  // El análisis llega del cliente: no es de fiar. Los permisos se vuelven a
  // comprobar aquí, contra la base y ANTES de escribir nada.
  if (!puede(ctx, 'productos.ver_costo') && importables.some((f) => f.datos.costPrice !== null)) {
    throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para cargar costos.')
  }
  if (!puede(ctx, 'productos.editar_precio')) {
    const catalogo = await db.product.findMany({
      where: { deletedAt: null },
      select: { sku: true, barcode: true, name: true, salePrice: true },
    })
    const bc = new Map(catalogo.filter((p) => p.barcode).map((p) => [p.barcode!, p]))
    const sk = new Map(catalogo.map((p) => [p.sku, p]))
    const nm = new Map(catalogo.map((p) => [p.name, p]))
    for (const f of importables) {
      const d = f.datos
      const ex =
        (d.barcode ? bc.get(d.barcode) : undefined) ??
        sk.get(d.sku ?? skuDesdeNombre(d.name)) ??
        (!d.barcode && !d.sku ? nm.get(d.name) : undefined)
      if (ex && redondear(Number(ex.salePrice)) !== redondear(d.salePrice)) {
        throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para cambiar precios de productos existentes.')
      }
    }
  }

  const warehouse = await db.warehouse.findFirst({
    where: { id: warehouseId, isActive: true, deletedAt: null },
    select: { id: true },
  })
  if (!warehouse) {
    throw new BusinessError('TENANT_MISMATCH', 'El almacén no está disponible.')
  }

  let creados = 0
  let actualizados = 0

  /**
   * Se escribe en LOTES y no en una transacción única.
   *
   * Dos mil productos en una sola transacción la mantienen abierta minutos
   * contra una base remota, bloqueando una conexión del pooler y arriesgando
   * un timeout que lo deshace todo tras varios minutos de espera. En lotes,
   * un fallo deja importado lo que ya entró — y como el emparejamiento es
   * idempotente por código de barras o SKU, volver a lanzar el archivo
   * completa lo que falte sin duplicar nada.
   */
  const LOTE = 50
  for (let i = 0; i < importables.length; i += LOTE) {
    const lote = importables.slice(i, i + LOTE)

    await db.$transaction(async (tx) => {
      const t = tx as unknown as TenantPrismaClient

      for (const fila of lote) {
        const d = fila.datos

        // Mismo orden que en el análisis: lo que se mostró en la vista
        // previa tiene que ser lo que ocurra.
        const existente =
          (d.barcode
            ? await t.product.findFirst({ where: { barcode: d.barcode, deletedAt: null }, select: { id: true } })
            : null) ??
          (await t.product.findFirst({
            where: { sku: d.sku ?? skuDesdeNombre(d.name), deletedAt: null },
            select: { id: true },
          })) ??
          (!d.barcode && !d.sku
            ? await t.product.findFirst({
                where: { name: d.name, deletedAt: null },
                select: { id: true },
              })
            : null)

        if (existente) {
          const antes = await t.product.findUniqueOrThrow({ where: { id: existente.id }, select: { barcode: true, qrCode: true } })
          const despues = await t.product.update({
            where: { id: existente.id },
            data: {
              name: d.name,
              salePrice: d.salePrice,
              // Solo lo que el archivo dice: un campo ausente no se pone a 0.
              ...(d.costPrice !== null ? { costPrice: d.costPrice } : {}),
              ...(d.minStock !== null ? { minStock: d.minStock } : {}),
              ...(d.unitType !== null ? { unitType: d.unitType as 'UNIDAD' } : {}),
              // barcode y qrCode solo se RELLENAN si faltaban: sobreescribir
              // el código de un producto ya etiquetado rompería su escaneo.
              ...(d.barcode ? { barcode: d.barcode } : {}),
              ...(d.qrCode ? { qrCode: d.qrCode } : {}),
              isActive: true,
            },
            select: { barcode: true, qrCode: true },
          })
          await registrarCodigosProducto(t, ctx.tenantId, { productId: existente.id }, despues, antes)
          actualizados++
          continue
        }

        const sku = d.sku ?? d.barcode ?? skuDesdeNombre(d.name)

        const producto = await t.product.create({
          data: {
            tenantId: ctx.tenantId,
            sku,
            barcode: d.barcode,
            qrCode: d.qrCode,
            name: d.name,
            unitType: (d.unitType ?? 'UNIDAD') as 'UNIDAD',
            salePrice: d.salePrice,
            costPrice: d.costPrice ?? 0,
            minStock: d.minStock ?? 0,
          },
          select: { id: true },
        })
        await registrarCodigosProducto(t, ctx.tenantId, { productId: producto.id }, { barcode: d.barcode, qrCode: d.qrCode })

        await t.stock.create({
          data: {
            tenantId: ctx.tenantId,
            productId: producto.id,
            variantId: null,
            warehouseId,
            quantity: d.stock,
            reserved: 0,
          },
        })

        // El movimiento INICIAL mantiene SUM(ledger) === Stock.quantity.
        if (d.stock > 0) {
          await t.stockMovement.create({
            data: {
              tenantId: ctx.tenantId,
              productId: producto.id,
              variantId: null,
              warehouseId,
              userId: ctx.userId,
              type: 'INICIAL',
              source: 'IMPORTACION',
              quantity: d.stock,
              balanceAfter: d.stock,
              unitCost: d.costPrice || undefined,
              costPending: !d.costPrice,
              unitCostApplied: d.costPrice || null,
              costAfter: d.costPrice ?? 0,
              costOrigin: 'EXACTO',
              reason: 'Importación masiva de catálogo',
              referenceType: 'MANUAL',
            },
          })
        }

        creados++
      }
    }, { maxWait: 15_000, timeout: 60_000 })
  }

  await db.auditLog.create({
    data: {
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      actorRole: ctx.role,
      action: 'catalog.import',
      entityType: 'Product',
      reason: 'Importación masiva de catálogo',
      after: {
        creados,
        actualizados,
        omitidos: analisis.resumen.error,
        total: analisis.resumen.total,
        fecha: now.toISOString(),
      },
      impersonationId: ctx.impersonationId ?? null,
    },
  })

  return { creados, actualizados, omitidos: analisis.resumen.error }
}
