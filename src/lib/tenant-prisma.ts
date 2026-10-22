import { prisma } from './prisma'
import { BusinessError, TenantIsolationError } from './errors'
import type { TenantContext } from './tenant-context'

/**
 * Cliente Prisma con aislamiento multi-tenant automático (§3, regla de oro).
 *
 * Implementado con Client Extensions (`$extends`), no con el middleware
 * `$use`: Prisma lo eliminó y además el middleware no podía distinguir
 * modelos ni tipar el resultado.
 *
 * QUÉ HACE en cada operación:
 *   1. Rechaza modelos que no estén clasificados abajo (deny by default).
 *   2. Inyecta `tenantId` en el `where` de toda lectura y escritura.
 *   3. Inyecta `tenantId` en el `data` de toda creación.
 *   4. Aborta si el llamador pasó un tenantId DISTINTO al de la sesión —
 *      esa es exactamente la forma que tendría un intento de fuga.
 *   5. Bloquea escrituras si la suscripción no está al día (§5.2).
 *
 * ⚠️ LÍMITES CONOCIDOS — leer antes de confiar ciegamente:
 *
 *   a) `$queryRaw` / `$executeRaw` NO pasan por esta extensión. Cualquier SQL
 *      crudo debe filtrar por tenantId a mano. Por eso no se exponen aquí.
 *
 *   b) Los writes ANIDADOS (`create: { items: { create: [...] } }`) no reciben
 *      el tenantId inyectado: la extensión solo toca el primer nivel. Recorrer
 *      el árbol de argumentos genéricamente es frágil y falla en silencio, que
 *      es el peor modo de fallo posible para una barrera de seguridad.
 *      Mitigación real: las FKs COMPUESTAS del schema. Un `SaleItem` anidado
 *      con tenantId equivocado revienta contra la FK
 *      (tenantId, productId) -> Product(tenantId, id) en la BD.
 *      Aun así: pasa `tenantId` explícito en cada nodo anidado.
 *
 *   c) Esto es una red de seguridad, NO un sustituto de revisar el código.
 *      La capa que de verdad garantiza el aislamiento es el schema.
 *
 * CÓMO USARLO EN LA PRÁCTICA:
 *   Escribe `tenantId: ctx.tenantId` EXPLÍCITO en cada `create`. TypeScript
 *   lo exige de todas formas (la inyección ocurre en runtime, donde los tipos
 *   generados por Prisma no la ven), y eso resulta ser lo correcto: el código
 *   dice a qué tenant escribe, y la extensión pasa a VERIFICAR esa afirmación
 *   en vez de suplirla en silencio. La inyección queda como red para el
 *   código que se olvide.
 */

/** Modelos filtrados por su columna `tenantId`. */
const TENANT_SCOPED = new Set([
  'Subscription',
  'User',
  'Branch',
  'UserBranch',
  'CashSession',
  'BranchTransfer',
  'BranchTransferItem',
  'Warehouse',
  'Category',
  'Supplier',
  'Customer',
  'Product',
  'ProductVariant',
  'Stock',
  'StockMovement',
  'Merma',
  'Invitation',
  'DeviceSession',
  'DiscountCap',
  'Sale',
  'SaleItem',
  'Payment',
  'Quote',
  'QuoteItem',
  'Purchase',
  'PurchaseItem',
  'DocumentCounter',
  'TaxDocument',
  'UsagePeriod',
  'AuditLog',
  'ImpersonationSession',
  'WebhookEvent',
])

/**
 * Modelos cuyas filas pertenecen a una sucursal, y por qué columna(s).
 *
 * Cuando el contexto trae `branchIds`, el cliente filtra por ellas SIN que el
 * servicio lo pida: un servicio que olvide acotar por sucursal no filtra datos
 * de un local ajeno. Es el mismo principio que `tenantId`, un nivel más abajo.
 *
 * Quedan fuera A PROPÓSITO `Warehouse`, `Stock` y `DocumentCounter`: una
 * transferencia obliga a mirar el almacén de OTRA sucursal, y ahí el acotado
 * lo hacen los servicios (`filtroAlmacen`, `verificarAlmacenDeSucursal`).
 * Las transferencias se ven desde cualquiera de sus dos extremos.
 */
interface AlcanceSucursal {
  columnas: readonly string[]
  /**
   * Relación hacia el padre que SÍ lleva la sucursal. Las líneas de venta, los
   * pagos o los comprobantes no tienen `branchId` propio: heredan el de su
   * venta. Sin esto, un `saleItem.groupBy` (un informe) saltaba el filtro.
   */
  via?: string
}

const BRANCH_SCOPED: Record<string, AlcanceSucursal> = {
  Sale: { columnas: ['branchId'] },
  Quote: { columnas: ['branchId'] },
  CashSession: { columnas: ['branchId'] },
  Merma: { columnas: ['branchId'] },
  BranchTransfer: { columnas: ['fromBranchId', 'toBranchId'] },
  SaleItem: { columnas: ['branchId'], via: 'sale' },
  Payment: { columnas: ['branchId'], via: 'sale' },
  TaxDocument: { columnas: ['branchId'], via: 'sale' },
  QuoteItem: { columnas: ['branchId'], via: 'quote' },
  BranchTransferItem: { columnas: ['fromBranchId', 'toBranchId'], via: 'transfer' },
}

function condicionDeSucursal(alcance: AlcanceSucursal, ids: readonly string[]): AnyArgs {
  const lista = [...ids]
  const propia = alcance.columnas.length === 1
    ? { [alcance.columnas[0]!]: { in: lista } }
    : { OR: alcance.columnas.map((c) => ({ [c]: { in: lista } })) }
  return alcance.via ? { [alcance.via]: propia } : propia
}

/** Añade una condición a `where` sin perder las claves únicas del nivel superior. */
function conjuntar(args: AnyArgs, condicion: AnyArgs): AnyArgs {
  const where = (args.where ?? {}) as AnyArgs
  const previo = where.AND === undefined ? [] : Array.isArray(where.AND) ? where.AND : [where.AND]
  return { ...args, where: { ...where, AND: [...previo, condicion] } }
}

function verificarSucursalEnData(data: AnyArgs, columnas: readonly string[], ids: readonly string[]) {
  const valores = columnas.map((c) => data[c]).filter((v) => typeof v === 'string') as string[]
  // Con una sola columna, el valor es obligatorio en el modelo; con dos (transferencia),
  // basta con que UNO de los extremos sea de una sucursal permitida.
  const permitido = columnas.length === 1
    ? valores.length === 0 || valores.every((v) => ids.includes(v))
    : valores.some((v) => ids.includes(v))
  if (!permitido) throw new TenantIsolationError('Esa sucursal no está disponible para tu usuario.')
}

/** El propio tenant: se filtra por `id`, no por `tenantId`. */
const SELF_SCOPED = 'Tenant'

/**
 * Catálogo global de planes. Lectura permitida (la app necesita conocer los
 * límites de su plan); escritura reservada al Super Admin vía `prisma` base.
 */
const GLOBAL_READONLY = new Set(['Plan'])

const READ_OPERATIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
])

const CREATE_OPERATIONS = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
])

const WHERE_WRITE_OPERATIONS = new Set([
  'update',
  'updateMany',
  'updateManyAndReturn',
  'delete',
  'deleteMany',
])

type AnyArgs = Record<string, any>

function assertSameTenant(candidate: unknown, tenantId: string) {
  if (candidate !== undefined && candidate !== null && candidate !== tenantId) {
    // No exponemos ninguno de los dos IDs: el mensaje viaja al cliente (§6.8).
    throw new TenantIsolationError()
  }
}

function injectIntoWhere(args: AnyArgs, key: string, tenantId: string): AnyArgs {
  const where = (args.where ?? {}) as AnyArgs
  assertSameTenant(where[key], tenantId)
  return { ...args, where: { ...where, [key]: tenantId } }
}

function injectIntoData(data: AnyArgs, tenantId: string): AnyArgs {
  assertSameTenant(data.tenantId, tenantId)
  return { ...data, tenantId }
}

export type TenantPrismaClient = ReturnType<typeof buildTenantClient>

function buildTenantClient(ctx: TenantContext) {
  const { tenantId, access } = ctx

  return prisma.$extends({
    name: 'tenant-isolation',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const isSelf = model === SELF_SCOPED
          const isScoped = TENANT_SCOPED.has(model)
          const isGlobalRead = GLOBAL_READONLY.has(model)

          // 1. Deny by default. Un modelo nuevo en el schema no queda
          //    accesible por accidente: hay que clasificarlo aquí a mano.
          if (!isSelf && !isScoped && !isGlobalRead) {
            throw new TenantIsolationError(
              'Este recurso no está disponible desde el contexto del negocio.',
            )
          }

          const isWrite = !READ_OPERATIONS.has(operation)

          /*
           * El REGISTRO DE AUDITORÍA se exceptúa del bloqueo por estado de
           * cuenta, y es deliberado.
           *
           * Un AuditLog no es una mutación de negocio: es la constancia de
           * algo que ya pasó. Bloquearlo tiene dos consecuencias malas y
           * ninguna buena:
           *
           *   1. Rompe el pago. Los checkouts declaran que NO escriben en la
           *      BD precisamente para que un moroso en READ_ONLY pueda
           *      pagar. Auditarlos —que es lo correcto, porque mueven dinero
           *      del dueño— volvería a bloquear a quien más necesita pagar.
           *   2. Pierde el rastro justo cuando más interesa. Las acciones de
           *      una cuenta suspendida o morosa son las que uno quiere poder
           *      reconstruir después, no las que conviene dejar sin registro.
           *
           * El riesgo es nulo: la tabla es de solo-añadir, los campos los
           * escribe nuestro código y el `tenantId` lo sigue inyectando y
           * verificando el mismo guard de aislamiento de arriba.
           */
          const esAuditoria = model === 'AuditLog'

          // 2. Enforcement del estado de pago sobre TODA escritura (§5.2).
          if (isWrite && !esAuditoria) {
            if (access === 'BLOCKED') {
              throw new BusinessError(
                'SUBSCRIPTION_BLOCKED',
                'La cuenta está suspendida. Contacta a soporte.',
              )
            }
            if (access === 'READ_ONLY') {
              // Durante una sesión de soporte el acceso también es READ_ONLY,
              // pero por un motivo COMPLETAMENTE distinto. Decirle al técnico
              // "tu suscripción no está al día" le haría diagnosticar un
              // problema de facturación que el cliente no tiene.
              throw new BusinessError(
                'SUBSCRIPTION_READ_ONLY',
                ctx.impersonationId
                  ? 'Modo soporte: la sesión es de solo lectura. Sal del modo soporte para operar con tu propia cuenta.'
                  : 'Tu suscripción no está al día. Puedes consultar información, pero no registrar cambios.',
              )
            }
          }

          // Esto sí se aplica a TODO, auditoría incluida: un modelo global de
          // solo lectura nunca se escribe, pase lo que pase.
          if (isWrite && isGlobalRead) {
            throw new TenantIsolationError('Recurso de solo lectura.')
          }

          if (isGlobalRead) {
            return query(args)
          }

          const scopeKey = isSelf ? 'id' : 'tenantId'
          let nextArgs = (args ?? {}) as AnyArgs

          // 3. Inyección en `where`.
          if (READ_OPERATIONS.has(operation) || WHERE_WRITE_OPERATIONS.has(operation)) {
            nextArgs = injectIntoWhere(nextArgs, scopeKey, tenantId)
          }

          // 3b. Acotado por sucursal (ver BRANCH_SCOPED).
          const alcanceSucursal = !isSelf && ctx.branchIds !== undefined ? BRANCH_SCOPED[model] : undefined
          // Solo los modelos con sucursal PROPIA se validan al crear; los hijos heredan la del padre.
          const columnasSucursal = alcanceSucursal && !alcanceSucursal.via ? alcanceSucursal.columnas : undefined
          if (alcanceSucursal && ctx.branchIds) {
            if (
              READ_OPERATIONS.has(operation) ||
              WHERE_WRITE_OPERATIONS.has(operation) ||
              operation === 'upsert'
            ) {
              nextArgs = conjuntar(nextArgs, condicionDeSucursal(alcanceSucursal, ctx.branchIds))
            }
          }

          // 4. Inyección en `data` (el Tenant no se autocrea desde aquí).
          if (CREATE_OPERATIONS.has(operation) && !isSelf) {
            const data = nextArgs.data
            if (columnasSucursal && ctx.branchIds) {
              for (const d of Array.isArray(data) ? data : [data]) {
                if (d && typeof d === 'object') verificarSucursalEnData(d, columnasSucursal, ctx.branchIds)
              }
            }
            if (Array.isArray(data)) {
              nextArgs = { ...nextArgs, data: data.map((d) => injectIntoData(d, tenantId)) }
            } else if (data && typeof data === 'object') {
              nextArgs = { ...nextArgs, data: injectIntoData(data, tenantId) }
            }
          }

          // 5. upsert toca where + create + update a la vez.
          if (operation === 'upsert' && !isSelf) {
            nextArgs = injectIntoWhere(nextArgs, scopeKey, tenantId)
            if (columnasSucursal && ctx.branchIds && nextArgs.create && typeof nextArgs.create === 'object') {
              verificarSucursalEnData(nextArgs.create, columnasSucursal, ctx.branchIds)
            }
            if (nextArgs.create && typeof nextArgs.create === 'object') {
              nextArgs = { ...nextArgs, create: injectIntoData(nextArgs.create, tenantId) }
            }
          }

          return query(nextArgs)
        },
      },
    },
  })
}

/**
 * Devuelve el cliente aislado para un contexto ya resuelto en el servidor.
 *
 * Deliberadamente NO se cachea por tenantId: el cliente lleva embebido el
 * `access` del momento. Un cliente cacheado seguiría escribiendo con permisos
 * de una suscripción que caducó hace una hora.
 */
export function getTenantPrisma(ctx: TenantContext): TenantPrismaClient {
  if (!ctx.tenantId) {
    throw new TenantIsolationError('Sesión sin negocio asociado.')
  }
  return buildTenantClient(ctx)
}
