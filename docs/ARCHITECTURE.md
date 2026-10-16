# Arquitectura de FerreSaaS

SaaS multi-tenant de inventario y punto de venta para ferreterías peruanas.

Este documento explica **por qué** el sistema está construido así. Las
decisiones que parecen raras suelen serlo porque la alternativa obvia falla de
una forma concreta que aquí se describe.

---

## Stack

| Pieza | Elección | Nota |
|---|---|---|
| Framework | Next.js 16 (App Router) | `middleware.ts` está deprecado → `src/proxy.ts`, que **siempre** corre en Node |
| Lenguaje | TypeScript estricto | |
| Estilos | Tailwind 4 | CSS-first: **no hay `tailwind.config.ts`**, los tokens van en `@theme` dentro de `globals.css` |
| ORM | Prisma 7.9 | Sin `url` en el `datasource` (vive en `prisma.config.ts`); driver adapter `@prisma/adapter-pg` obligatorio |
| Base | PostgreSQL (Neon) | |
| Validación | Zod 4 | |
| Sesión | NextAuth v5 beta, estrategia JWT | |
| Pagos | Stripe + MercadoPago | |
| Escáner | `@zxing/browser` | |

---

## 1. Multi-tenancy: por qué no basta con `tenantId`

Base y esquema compartidos, con `tenantId` en toda tabla de negocio. Lo que
sostiene el aislamiento son **dos** capas, y ninguna sobra:

### 1.1 Claves foráneas COMPUESTAS `(tenantId, id)`

```prisma
product Product @relation(fields: [tenantId, productId], references: [tenantId, id])
```

Un `SaleItem` **físicamente no puede** apuntar a un `Product` de otro tenant:
no es que el código lo evite, es que Postgres rechaza la fila. Con una FK
simple `productId → Product.id`, un bug de código o una consulta a mano
bastarían para cruzar catálogos, y el daño sería invisible hasta que alguien
viera el producto de otro negocio en su propia venta.

`tests/tenant-isolation.ts` inserta el cruce con SQL **a mano** y comprueba que
revienta la FK compuesta correcta.

### 1.2 `getTenantPrisma(ctx)` con lista blanca **deny-by-default**

Extensión de Prisma Client (`$extends`, no el `$use` deprecado) que inyecta y
verifica `tenantId` en cada consulta. Un modelo que no esté en `TENANT_SCOPED`
se **bloquea**, no se deja pasar. El default importa: si fuera al revés, añadir
un modelo nuevo y olvidar registrarlo lo dejaría accesible a todos los
tenants, y nada fallaría.

### 1.3 Aislamiento **entre sucursales** del mismo tenant

El `tenantId` no separa establecimientos: todos los almacenes de todas las
sucursales son del mismo negocio. Esa frontera la ponen comprobaciones
explícitas:

- `requireBranch(ctx)` — sin sucursal no se emite nada.
- `filtroAlmacen(ctx.branchId, ...)` — un almacén solo se resuelve dentro de
  la sucursal activa.
- `registerSale` verifica `warehouse.branchId === ctx.branchId`.

---

## 2. Identidad en el JWT, autorización desde la base

El JWT lleva **solo** `sub` (el `userId`). El `tenantId`, el rol, el estado de
la cuenta y las sucursales se resuelven **en cada petición** desde Postgres.

Si el rol viajara en el token, degradar a un empleado de ADMIN a CAJERO no
surtiría efecto hasta que su sesión caducara —12 horas— y durante ese tiempo
seguiría pudiendo hacer lo que se le acaba de quitar. Lo mismo con una
suscripción cancelada.

El coste es una consulta por petición. Se paga a propósito, y se mitiga con
`SKIP_SESSION_PREFIXES`: las rutas que se autentican por otra vía (firma HMAC
de los webhooks, `CRON_SECRET`, el callback de NextAuth) **no** resuelven
sesión, porque Neon suspende el cómputo por inactividad y esa consulta en el
camino crítico del login hacía que «Entrar» se quedara colgado.

**Revocación real:** `User.passwordChangedAt`. La sesión guarda su `iat`; si es
anterior, se rechaza. Sin esta columna, cambiar la contraseña porque sospechas
que te la robaron **no echaría** a quien ya tiene sesión abierta.

---

## 3. Concurrencia de stock

Un único `UPDATE ... WHERE quantity >= $n` condicional vía
`updateManyAndReturn`. Postgres reevalúa el `WHERE` tras liberar el bloqueo
(EvalPlanQual), así que de dos ventas simultáneas de la última unidad, una
falla con `INSUFFICIENT_STOCK` en vez de dejar el stock en negativo.

Para ajustes **absolutos** (conteo físico) hace falta algo distinto: bloqueo
optimista con `Stock.version`. Un conteo se calcula contra lo que el operario
vio en pantalla; si alguien vendió en medio, el ajuste debe fallar, no pisar.

`applyStockMovement` está extraído para que el POS lo reutilice **dentro de su
propia transacción**, y por eso hereda el guard. Acepta dos escapes
explícitos:

- `allowNegative` — venta forzada (§5.4). El cliente está en el mostrador y el
  producto existe aunque el sistema no lo sepa.
- `typeOverride` — las transferencias necesitan el efecto de una SALIDA con la
  etiqueta `TRANSFERENCIA_SALIDA` en el kardex. Sin esto, el servicio de
  transferencias tendría que reimplementar el guard atómico.

---

## 4. Numeración sin huecos

```sql
UPDATE document_counters SET next = next + 1 RETURNING next
```

Dentro de **la misma transacción** que la venta. Si la venta hace rollback, el
número se devuelve. Esto **serializa** las transacciones de la misma serie:
el techo es ~1 venta/segundo por serie. Es el precio inevitable de numerar sin
huecos y está documentado, no es un descuido.

### Series por sucursal

`Branch.seriesNumber` (1–999, único por tenant) determina la serie de **todos**
los documentos de ese local: la sucursal 1 emite `V001`/`B001`/`F001`, la 2
emite `V002`/`B002`/`F002`.

El invariante que lo hace seguro es el único **`(tenantId, scope, series)`** en
`DocumentCounter`: una serie pertenece a UNA sola sucursal. Gracias a eso la
serie identifica el contador por sí sola y **`claimNextNumber` no cambió de
firma** al introducir multi-sucursal — la lógica más delicada del proyecto
quedó intacta.

Si en cambio la clave fuera `(tenantId, branchId, scope, series)`, dos
sucursales podrían abrir contadores `B001` independientes y **ambas** emitirían
`B001-00000001`: correlativos solapados bajo un mismo RUC.

**Retrocompatibilidad:** la sucursal que creó la migración para los datos
existentes lleva `seriesNumber = 1`, de donde sale exactamente la serie `001`
ya en uso. Ni un número cambió.

---

## 5. IGV: se EXTRAE, no se suma

En Perú el precio de etiqueta incluye IGV:

```
base = neto / (1 + tasa)
igv  = neto - base
```

Sumarlo encima haría que la boleta cobrara un 18 % más de lo que marca la
etiqueta. La tasa se congela por línea al vender, así que un cambio de tasa no
altera lo ya emitido.

**Dinero:** importes en `Decimal(14,2)` en la base; el MRR del Super Admin en
**céntimos enteros** para no acumular deriva de coma flotante. El redondeo a
céntimos vive en `src/lib/dinero.ts`, y usa `toFixed(4)` antes de
`Math.round` porque `Math.round(0.145 * 100)` da **14**, no 15.

---

## 6. Idempotencia

| Dónde | Clave |
|---|---|
| Movimientos de stock | `StockMovement.idempotencyKey` (la genera el cliente antes de enviar) |
| Webhooks de pago | `WebhookEvent (provider, externalEventId)` |
| Ventas | `Sale.number` único por tenant |
| Comprobantes | `TaxDocument` único por venta — reintentar devuelve el mismo |
| Checkout de Stripe | cabecera `Idempotency-Key` |

El almacenero trabaja con conectividad intermitente: la app reintenta y el
movimiento se aplica **una** vez.

---

## 7. Webhooks

HMAC a mano con `timingSafeEqual` y ventana anti-replay.

**MercadoPago firma el manifiesto, no el cuerpo.** Por eso el recurso se
**vuelve a consultar** a su API en lugar de confiar en el payload recibido.

Los webhooks están en `PUBLIC_PREFIXES` por necesidad: llegan sin cookie. Si
el proxy los redirigiera al login, el proveedor leería el 307 como fallo de
entrega, reintentaría, volvería a fallar y acabaría **desactivando el
endpoint** — y el estado de suscripción quedaría congelado para siempre sin
que nadie se enterara.

---

## 8. Bloqueo progresivo por impago

`computeAccessLevel()` es una función **pura** (y por eso testeable sin base):

```
suspendido por el Super Admin  → BLOCKED    (manda sobre todo)
CANCELED                       → READ_ONLY
PAST_DUE dentro de la gracia   → WARN       (banner, sigue operando)
PAST_DUE pasada la gracia      → READ_ONLY
TRIALING vencido               → READ_ONLY
ACTIVE / TRIALING vigente      → FULL
```

`READ_ONLY` y no `BLOCKED` para la mora es deliberado: el ferretero que no
pagó debe poder seguir consultando su inventario y reimprimir sus
comprobantes. Cortarle el acceso a su propia información convierte un problema
de cobranza en una disputa. Y `/facturacion` queda abierta en `READ_ONLY`,
porque si no el moroso no podría llegar a la pantalla donde paga.

---

## 9. Sucursales, caja y transferencias

### Sucursal ≠ almacén

SUNAT numera por **establecimiento**. Una tienda con sala de ventas y depósito
trasero es **un** establecimiento con **dos** almacenes y **una** serie. Si la
sucursal fuese el almacén, esa tienda declararía dos establecimientos que no
existen.

### Turno de caja

Es por **sucursal**, no por usuario: el cajón es físico y está en un local
concreto. Índice **parcial** `WHERE status = 'ABIERTA'` para que no haya dos
turnos abiertos en el mismo local — Prisma no sabe expresarlo, así que va a
mano en el SQL de la migración.

El arqueo se **congela** al cerrar. Si se recalculara al leer, anular una venta
mañana cambiaría el arqueo que el cajero firmó hoy, y dejaría de probar nada.

El esperado suma **pagos en efectivo** menos vueltos, no el total vendido: una
venta por Yape no pone un sol en el cajón.

### Transferencias en DOS pasos

El stock **sale** del origen al despachar y **entra** al destino al recibir.
Un movimiento instantáneo sería más simple y **mentiría** durante todo el
tiempo que la mercadería va en la camioneta — y es ahí donde se pierde.

Si llega menos de lo despachado, **no se asienta ningún movimiento extra**, y
esto es contraintuitivo a propósito: el libro ya refleja la pérdida, porque el
origen descontó todo lo enviado y el destino sumó solo lo que llegó. Una merma
adicional restaría **dos veces**. El rastro queda en la línea
(`quantitySent` vs `quantityReceived`) y en el `AuditLog`.

⚠️ **Deuda conocida:** falta un almacén de tránsito que convierta el viaje en
un saldo explícito. Hoy el total del sistema baja mientras la mercadería viaja.
Es correcto (no está en ningún estante) pero no es visible como saldo.

---

## 10. Mapa del código

```
src/
  app/
    (auth)/          login, registro
    (dashboard)/     pos, inventario, cotizaciones, comprobantes,
                     caja, transferencias, sucursales, facturacion
    (print)/         imprimir/[tipo]/[id]  ← grupo HERMANO: sin barras de navegación
    (superadmin)/    torre de control
    api/             auth, webhooks, cron, tenants, invoices, diagnostics
  features/
    branches/        sucursales, caja, transferencias, series
    inventory/       stock, alta exprés, importación CSV
    pos/             ventas, cotizaciones
    invoicing/       comprobantes tributarios
    printing/        ticket térmico de 80 mm
    billing/         Stripe, MercadoPago, webhooks, bloqueo
    superadmin/      métricas, kill switch, impersonation
    shell/           navegación compartida
  lib/               prisma, tenant-prisma, session, csrf, rate-limit,
                     dinero, fecha-local, numero-a-letras, quantity,
                     plan-limits, prisma-errors, branch-selection
  proxy.ts           reemplaza middleware.ts (Next 16)
```

### Reglas de oro

1. **Toda Server Action valida permisos en el SERVICIO**, no en la UI. Una
   Server Action es un endpoint HTTP y cualquiera puede invocarla a mano.
2. **Prohibido `prisma db push` en producción.** Solo `migrate deploy` con
   migraciones revisadas.
3. **Soft delete** (`deletedAt`) en clientes, ventas, productos y sucursales.
   Nunca `DELETE` de algo con historial.
4. **Los scripts abortan contra producción** (`src/lib/env-guard.ts`,
   `tests/guard.ts`). La suite se **niega** a correr sin
   `ALLOW_DESTRUCTIVE_TESTS=true`, variable que producción nunca llevará.
5. **Fechas siempre con la zona del negocio.** El servidor corre en UTC; sin
   `timeZone` explícito, una venta de las 21:00 en Lima se fecha al día
   siguiente. Usar `formatearFechaLocal` de `src/lib/fecha-local.ts`.

---

## 11. Trampas ya pisadas (para no repetirlas)

| Trampa | Síntoma | Lección |
|---|---|---|
| `throw` a nivel de módulo en `prisma.ts` | 500 en **todas** las rutas, cero logs, stack traces minificados | La cadena `proxy → auth → credentials → prisma` mataba el proceso al importar. Ahora es un Proxy perezoso |
| `e.meta.target` en errores P2002 | El mensaje decía «SKU duplicado» cuando el duplicado era el código de barras | El **driver adapter** de `pg` NO rellena `target`. Usar `camposDeColision()` de `src/lib/prisma-errors.ts` |
| `APP_URL=""` | URLs de retorno de Stripe relativas | `'' ?? x` es `''`. Usar `\|\|`, no `??` |
| `Math.round(n * 100)` | `0.145` → `14/100` | La deriva binaria. Usar `src/lib/dinero.ts` |
| Precios recalculados al convertir cotización | Una cotización de S/130 intentaba cobrar S/200 | Congelar precios y pasarlos **como argumento de función**, fuera del esquema Zod: en el cuerpo, el navegador podría vender a cualquier precio |
| Diagnóstico contando **filas** de `_prisma_migrations` | Una migración a medias se reportaba como aplicada | Filtrar `finished_at IS NOT NULL AND rolled_back_at IS NULL` |
| «Cualquier almacén activo» | Tras multi-sucursal, el cajero de otro local veía el almacén equivocado y cada cobro fallaba | `filtroAlmacen(ctx.branchId)` |
