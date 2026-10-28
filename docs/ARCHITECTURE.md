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

## 2. El proxy NO consulta la base

Es la propiedad que más condiciona el rendimiento del panel, y la más fácil de
romper sin darse cuenta.

El proxy de Next 16 se despliega **distribuido**: corre en la región más
cercana al usuario, no donde estén las funciones. Medido en producción, sobre
el mismo despliegue:

```
proxy   → gru1   (São Paulo)
función → cle1   (Cleveland, us-east-2, pegada a Neon)
```

Y `vercel.json → regions` **no lo cambia**: eso solo mueve las Vercel
Functions. Así que cuando el proxy consultaba la sesión, esa consulta cruzaba
São Paulo → Ohio en cada navegación: **~120-140 ms**, el gasto mayor de toda
la aplicación.

Ahora decide solo con lo que viene firmado —el JWT y el token de soporte— y
`proxy_total` bajó a **1-2 ms**.

**El enforcement no se movió:** sigue en la base, al renderizar y al escribir.
Ver `docs/REGIONES.md` para la tabla de qué se comprueba dónde, y
`tests/proxy-sin-bd.ts` para la prueba **estructural** que falla si alguna
ruta o Server Action se la salta.

⚠️ **Si alguien vuelve a meter una consulta en el proxy**, lo delata
`post_jwt` en la cabecera `Server-Timing`: mide el tramo donde viviría, y
desde `gru1` una consulta cuesta ~120 ms. Un tramo de un dígito es
físicamente incompatible con una consulta — por eso se mide en vez de
declararse. La primera versión ponía `sesion_bd;dur=0` escrito a mano, y un
literal no detecta nada.

---

## 3. Identidad en el JWT, autorización desde la base

El JWT lleva `sub` (el `userId`) y el **rol del momento del login**. El
`tenantId`, el estado de la cuenta y las sucursales se resuelven **en cada
petición** desde Postgres.

El rol está en el token por una sola razón: que el proxy pueda enrutar sin
consultar la base (ver §2). **No es la fuente de verdad de la autorización.**
Si el del token y el de la base discrepan, manda la base.

Consecuencia aceptada: ascender a alguien a SUPERADMIN exige que vuelva a
entrar para que el proxy le deje pasar a `/superadmin`. **Degradar surte efecto
de inmediato**, porque el enforcement lo hace la base — y ese es el lado que
importa.

Si la AUTORIZACIÓN viajara en el token, degradar a un empleado de ADMIN a
CAJERO no surtiría efecto hasta que su sesión caducara —12 horas— y durante ese
tiempo seguiría pudiendo hacer lo que se le acaba de quitar. Lo mismo con una
suscripción cancelada. De ahí que el rol del token solo sirva para elegir
rutas, nunca para permitir operaciones.

El coste es una consulta por petición, que se paga a propósito y se mitiga de
tres formas:

- `SKIP_SESSION_PREFIXES`: las rutas que se autentican por otra vía (firma HMAC
  de los webhooks, `CRON_SECRET`, el callback de NextAuth) **no** resuelven
  sesión. Sin esto, Neon despertando en el camino crítico del login hacía que
  «Entrar» se quedara colgado.
- `cache()` de React sobre `requireTenantContext`: el layout, los banners y la
  página comparten **una** consulta por render. Medido: eran **3**.
- `relationLoadStrategy: 'join'`: la consulta de sesión se resolvía en **3,2
  idas y vueltas** porque Prisma partía los `select` anidados en una consulta
  por relación. Con LATERAL JOIN es **1,0**.

**Revocación real:** `User.passwordChangedAt`. La sesión guarda su `iat`; si es
anterior, se rechaza. Sin esta columna, cambiar la contraseña porque sospechas
que te la robaron **no echaría** a quien ya tiene sesión abierta.

---

## 4. Concurrencia de stock

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

## 5. Numeración sin huecos

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

## 6. IGV: se EXTRAE, no se suma

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

## 7. Idempotencia

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

## 8. Webhooks

HMAC a mano con `timingSafeEqual` y ventana anti-replay.

**MercadoPago firma el manifiesto, no el cuerpo.** Por eso el recurso se
**vuelve a consultar** a su API en lugar de confiar en el payload recibido.

Los webhooks están en `PUBLIC_PREFIXES` por necesidad: llegan sin cookie. Si
el proxy los redirigiera al login, el proveedor leería el 307 como fallo de
entrega, reintentaría, volvería a fallar y acabaría **desactivando el
endpoint** — y el estado de suscripción quedaría congelado para siempre sin
que nadie se enterara.

---

## 9. Bloqueo progresivo por impago

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

## 10. Sucursales, caja y transferencias

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

## 11. Mapa del código

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

## 11b. Permisos: un poder = un permiso nombrado

`puede(ctx, 'permiso')` es la **única** función que decide (`src/lib/puede.ts`);
la matriz rol → permisos vive en `src/lib/permisos.ts`.

### Por qué no existe `puedeTodo`

Exigir dos permisos a la vez para autorizar UNA operación parece una forma
cómoda de afinar, y deja de serlo en cuanto un usuario puede tener varios
roles: **los permisos se unen**. Un `CAJERO + CONTADOR` suma `caja.abrir_cerrar`
y `caja.arqueo`, cumple la «intersección» sin que ninguno de sus roles
quisiera ese poder, y cierra el cajón del compañero.

Era exactamente lo que hacía «cerrar el turno de otro». Ahora es
`caja.cerrar_ajeno`, solo DUEÑO y ADMIN.

**Regla:** si una operación necesita una combinación, **la combinación se
nombra** y se concede a los roles que toque. `puedeAlguno` sobrevive solo para
decidir qué PINTAR (páginas y menú), nunca para autorizar en un servicio.

### Lo que la revisión encontró además de los `puedeTodo`

La misma enfermedad aparece de formas que ningún lint de «combinaciones»
detecta, así que se busca preguntando *«¿esta operación hace más de lo que su
permiso nombra?»*:

- **`commitImport`** actualiza `salePrice` y `costPrice` de productos
  EXISTENTES, guardado solo con `productos.crear`. Un almacenero podía cambiar
  precios y costos subiendo un CSV.
- **`createTransfer`** (pedir mercadería) se guardaba con `despachar`. Solo
  coincidía porque el almacenero tenía los dos. Ahora es `solicitar`, y el
  ciclo `solicitar → aprobar → despachar → recibir` tiene un permiso por paso.
- **`searchForTransfer`** no exigía NINGÚN permiso: cualquier usuario con
  sesión consultaba nombre y saldo de cualquier almacén de su negocio, y una
  Server Action es un endpoint HTTP que se puede invocar a mano.

---

### Alcance por sucursal: `ctx.branchIds`

`ctx.branchId` es la sucursal donde el usuario OPERA; `ctx.branchIds`, hasta
dónde LLEGA. Lo calcula `resolveTenantContext` en la misma sentencia de la
sesión: las asignadas (`UserBranch`), o TODAS las activas del negocio si el
rol tiene `sucursales.gestionar` (dueño y administrador). Sin asignaciones
queda vacío y no se ve nada.

`getTenantPrisma` acota por esa lista, sin que el servicio lo pida, las
lecturas, actualizaciones, borrados y altas de `Sale`, `Quote`, `CashSession`,
`Merma` y `BranchTransfer` (esta última por cualquiera de sus dos extremos).
`Warehouse`, `Stock` y `DocumentCounter` quedan fuera a propósito: una
transferencia obliga a mirar el almacén de otra sucursal y ahí acotan los
servicios (`filtroAlmacen`). `branchIds === undefined` significa «sin
restricción» (SUPERADMIN, alta del negocio, scripts), y `tests/branch-ids.ts`
comprueba por AST que todo contexto de usuario de `session.ts` lo trae; si no,
el filtro se apagaría en silencio.

**Reposición desde el destino.** `createTransfer` admite `sentido: 'PEDIR'`:
quien está en el destino le pide mercadería a otra sucursal. Su sucursal sale de
la sesión y es siempre el DESTINO; solo se nombra al otro extremo. El origen
atiende el pedido con el mismo ciclo (aprobar → despachar → recibir). Antes,
el botón «Pedir mercadería a otra sucursal» creaba en realidad un envío desde
el almacén de quien lo pulsaba.

### Usuarios, invitaciones y varios roles

`/usuarios` (permiso `usuarios.gestionar`: dueño y administrador). Una persona
entra al negocio por **invitación**: un token de 256 bits, de un solo uso y con
7 días de vida. En la base solo se guarda su hash SHA-256; el enlace en claro se
muestra una vez, al crearla. Quien acepta solo aporta nombre y contraseña: rol,
sucursales y negocio salen de la fila de la invitación, y el consumo es un
`UPDATE` condicional, así que dos clics simultáneos crean una sola cuenta. Al
reinvitar el mismo correo, la invitación anterior queda anulada. El cupo del
plan cuenta usuarios activos **más** invitaciones vivas.

**Nadie concede más poder del que tiene** (`asignacion.ts`): un rol solo se
puede dar si todos sus permisos están entre los de quien lo da. Un ADMIN puede
crear otros administradores y los demás roles, pero no un dueño; la regla se
deriva de la matriz, no de una escalera de rangos, y vale igual con varios
roles. El OWNER y el SUPERADMIN no se conceden por invitación, ni siquiera el
dueño (traspasar la propiedad será una operación aparte). Nadie cambia su
propio rol ni se desactiva, nadie toca al dueño y nadie gestiona a quien tenga
permisos que él no alcanza. Desactivar a alguien invalida sus sesiones abiertas.

`User.extraRoles` guarda los roles adicionales; `resolveTenantContext` los
vuelca en `TenantContext.roles` y los permisos se **unen**.

### Panel, demo y facturación (octubre 2026)

- **Panel (`/panel`)** es la pantalla de aterrizaje. Cada bloque pide su permiso
  al *servicio* (`reportes.ver` para ventas y ranking; `caja.arqueo` o
  `reportes.ver` para caja; las alertas de stock, ninguno, igual que el POS).
  «Hoy», «semana» y «mes» se calculan en la zona del negocio
  (`src/lib/periodos.ts`), no en la del servidor. Sin costos ni márgenes.
- **Alcance por sucursal en tablas hijas**: `SaleItem`, `Payment`, `TaxDocument`,
  `QuoteItem` y `BranchTransferItem` heredan el filtro de su padre. Sin esto, un
  `groupBy` (un informe) saltaba `ctx.branchIds`.
- **Cuenta demo** (`src/features/demo`): `Tenant.isDemo`. Se crea con
  `npm run demo:crear`; los datos pasan por los servicios reales del POS. El
  sembrado es reanudable y el reclamo caduca (10 min), así que una función
  cortada no deja la demo rota. No paga, no habla con un proveedor real.
- **Caja obligatoria** (`Tenant.cashRequired`): cobrar en efectivo exige turno
  abierto. Se consulta solo cuando no hay turno, para no encarecer la venta normal.
- **Facturación**: ver `docs/COMPLIANCE.md` §6. El flujo es
  `TaxDocument` → `ComprobanteFiscal` → UBL de comprobación → proveedor →
  respuesta guardada. Un negocio real nunca usa el simulado.
- **Decimales**: `tieneMaxDecimales` sustituye a `Math.round(n*100) === n*100`,
  que rechazaba 1,10; 8,20 o 19,99 por error de coma flotante.

### Sesiones por dispositivo y PIN de cajero

**Sesiones.** Cada inicio de sesión crea una `DeviceSession`; su id (`sid`) viaja
en el JWT. `resolveTenantContext` comprueba en la MISMA sentencia que ya resuelve
al usuario (un `join`, sin ida y vuelta extra) que el `sid` exista y no esté
revocado. Revocar surte efecto en la siguiente navegación o Server Action, y
cada acción que escribe dinero resuelve el contexto de nuevo, así que no hace
falta una comprobación aparte. Los JWT anteriores a esto no llevan `sid` y se
aceptan hasta caducar (12 h). `/seguridad` lista y cierra las propias; un
dueño/administrador cierra las de quien tenga menos poder que él.

**PIN de cajero.** Identifica a quien opera en un dispositivo cuya sesión ya
está abierta; no es un segundo login. La cookie `ferresaas.operador` está
firmada con HMAC y atada al `sid` y al usuario de la sesión. El contexto
resultante tiene la identidad del operador y permisos = **intersección** de los
de la sesión y los del operador, menos `usuarios.gestionar`,
`sucursales.gestionar`, `plan.gestionar`, `config.fiscal` y
`comprobantes.estado_manual` (se comprueba para las 36 combinaciones de roles).
Solo entran usuarios asignados a la sucursal activa. El intento se **reserva con
un incremento atómico antes de comparar**, así que una ráfaga de peticiones
simultáneas prueba como mucho 5 PIN; al 5.º fallo se bloquea y solo un
dueño/administrador lo libera. Cada uso, fallo, bloqueo y desbloqueo se audita
(sin el PIN). Un PIN son pocas cifras: el bloqueo y el límite por conexión son
lo que lo protege, no el hash.

### PSE, credenciales cifradas y padrón en vivo

Los comprobantes se firman y envían por un **PSE** (REST), no con certificado del
negocio. `Tenant.pseEndpointUrl` (host público, validado contra SSRF) y
`pseTokenEnc` (AES-256-GCM, atado al `tenantId`, clave maestra `PSE_MASTER_KEY`)
guardan la configuración; el token solo se descifra en el servidor. Las
peticiones salen por `lib/http-seguro.ts`: tiempo total acotado, respuesta
acotada, sin redirecciones y con la IP comprobada **al conectar** (anti DNS
rebinding). El adaptador (`providers/pse-rest.ts`) distingue fallo transitorio
(reintentable, nunca aceptado), rechazo del comprobante (RECHAZADO) y mal
configurado (401/403: no cambia el estado). `TaxDocumentStatus` incorpora
`OBSERVADO` (aceptado con observaciones). Detalle del contrato:
`docs/PSE-CONTRATO.md`. El padrón RUC/DNI (`padron-http.ts`) tiene 2,5 s de
plazo, caché de 6 h y cortacircuitos de 30 s; cualquier fallo vuelve a «teclea
el nombre» y nunca frena una venta.

### Venta por pedidos (cola de caja)

`Quote.kind = PEDIDO`: una venta que arma quien vende (`ventas.crear`) y cobra
quien tiene `ventas.cobrar`. Comparte tabla y líneas con las cotizaciones pero
tiene **listado propio** (`/pedidos`; `/cotizaciones` filtra por tipo), serie
propia (`O001-…`), nace `ENVIADA` y **no cuenta** para el límite de cotizaciones
del plan. **No reserva stock**: la venta lo descuenta al cobrar, con el guard de
siempre. Se cobra con los precios congelados al armarlo.

- **Un cajero a la vez:** «tomarlo» es un `UPDATE` condicional (libre, mío o
  reserva caducada), así que de cinco cajeros simultáneos gana uno. La reserva
  dura 5 min y se renueva mientras la pantalla está abierta; si el cajero se
  cae, otro lo toma. `convertQuoteToSale` rechaza cobrar un pedido que no se
  tiene tomado: sin eso, la venta (transacción 1) y el marcado como convertido
  (transacción 2) permitían un doble cobro.
- **Cola por sucursal:** solo los de la sucursal activa (además del filtro por
  `ctx.branchIds`). Quien solo vende ve únicamente los suyos.
- **Vencen** al cerrar la caja de su sucursal, o al acabar el día del negocio
  (`validUntil`, aplicado de forma perezosa en cada consulta: no hace falta un
  cron). Un vencido no se toma ni se cobra.

### Topes de descuento por rol

`ventas.descuento` **no se comprobaba en ningún sitio**: quien podía cobrar
podía enviar el descuento que quisiera invocando la acción a mano, y el POS ni
tenía campo de descuento. Ahora `validarDescuentoLinea` (`src/lib/descuentos.ts`)
se aplica en la venta y en la cotización/pedido: sin el permiso, cualquier
descuento se rechaza; con él, no puede pasar del tope del rol (en % de la
LÍNEA, redondeado a céntimos como el cobro).

Tope por rol en `DiscountCap` (sin fila: dueño y administrador 100 %, el resto
0 %). El dueño no se limita; el del administrador solo lo fija el dueño. Un
tope > 0 para VENDEDOR o CAJERO **activa** su permiso opcional (no hay un
interruptor aparte que pueda contradecirlo); se resuelve en `resolveTenantContext`
dentro de la misma consulta. Un pedido o cotización lo autoriza quien lo arma
con SU tope; el cajero que lo cobra no lo revalida (`descuentosYaAutorizados`),
porque un cajero sin permiso debe poder cobrar el pedido con descuento que armó
un vendedor autorizado. El operador por PIN recibe el menor entre el tope de la
sesión y el suyo. Toda venta con descuento deja `sale.discount` en la auditoría.

### `productos.ver_costo`: qué protege hoy

Hoy el costo entra por tres caminos y los tres lo exigen en el servidor:
alta exprés (`costPrice`), entrada de stock (`unitCost`) e importación CSV
(columna de costo; se revalida en `commitImport`, que no se fía del análisis
que manda el cliente). Quien no puede ver costos registra solo cantidades:
la entrada queda `costPending` y no alimenta ningún costo promedio hasta que
alguien con el permiso la completa (`completarCostoEntrada`, auditada).

`commitImport` tampoco cambia precios de productos existentes sin
`productos.editar_precio`, y un campo ausente del archivo ya no se pone a 0
(`null` = «no tocar»; antes reimportar sin columna de costo lo borraba).

Aún **no existen** cálculo de costo promedio, exportación de costos ni
informe de margen. La prueba `tests/costo.ts` fija por AST qué archivos
pueden nombrar `costPrice`/`unitCost` y que ningún acceso a Product o
StockMovement fuera de ellos omita `select`; cuando se construyan esas
superficies, deben nacer con `puede(ctx, 'productos.ver_costo')`.

## 12. Pruebas estructurales: por AST, nunca por texto

Hay invariantes que ninguna prueba de comportamiento alcanza. El principal:
**que ninguna página ni Server Action se salte la verificación de sesión**
contra la base. Antes lo cubría el 307 del proxy; desde que el proxy no
consulta (§2), un olvido sería un agujero real.

`tests/proxy-sin-bd.ts` lo comprueba recorriendo el código y **falla nombrando
el archivo**. Las excepciones son una lista explícita con su motivo, así que
añadir una ruta pública exige escribir por qué.

### Por qué AST y no `includes()`

La primera versión buscaba texto y dio **tres falsos positivos seguidos**,
todos por la misma causa: la cadena buscada aparecía en un **comentario que
explicaba por qué el código NO hacía eso**.

Filtrar las líneas que empiezan por `*` o `//` tapa el síntoma y falla con un
comentario al final de una línea de código, o con una cadena que contenga la
palabra. **El AST no tiene ese problema:** los comentarios no son nodos del
árbol, y un identificador se distingue de una cadena literal por construcción.

`tests/ast.ts` ofrece las consultas: `imports`, `llamadas`,
`identificadores`, `cadenas`, `tieneDefaultDeCadena`, `esValorCalculado`,
`dependeDeLaBase`.

Dos detalles que solo el AST acierta:

- **`dependeDeLaBase`** ignora los imports de TIPO. `route-access.ts` importa
  `type { Role }` del cliente generado, y eso se borra al compilar: el módulo
  sigue siendo puro. Contarlo habría sido un cuarto falso positivo.
- **`esValorCalculado`** distingue una plantilla con sustituciones de una
  cadena escrita a mano. Existe porque la cabecera `Server-Timing` llevaba
  `sesion_bd;dur=0` como literal con un comentario diciendo que si cambiaba
  sería que alguien reintrodujo la consulta — falso: un literal nunca cambia.

El analizador se comprueba a sí mismo con un **señuelo**: un archivo que solo
menciona `requireTenantContext` en comentarios y cadenas debe dar «no
verifica», y otro que sí lo llama debe dar «verifica». Sin eso, un helper roto
que devolviera siempre «todo bien» dejaría pasar la suite entera.

### La dependencia

`ts-morph`, solo como **devDependency** (nunca viaja a producción).

TypeScript 7 es el compilador reescrito en Go: su entry principal exporta
**solo `version`**, y la API clásica (`ts.createSourceFile`,
`ts.forEachChild`) ya no existe. Lo que queda está en
`typescript/unstable/ast`, sin función de parseo expuesta y marcado
**unstable** por el propio proveedor. Una suite que debe quedarse verde no se
apoya en eso. Comprobado: `ts-morph` no añade ninguna vulnerabilidad al árbol.

---

## 13. Trampas ya pisadas (para no repetirlas)

| Trampa | Síntoma | Lección |
|---|---|---|
| `throw` a nivel de módulo en `prisma.ts` | 500 en **todas** las rutas, cero logs, stack traces minificados | La cadena `proxy → auth → credentials → prisma` mataba el proceso al importar. Ahora es un Proxy perezoso |
| `e.meta.target` en errores P2002 | El mensaje decía «SKU duplicado» cuando el duplicado era el código de barras | El **driver adapter** de `pg` NO rellena `target`. Usar `camposDeColision()` de `src/lib/prisma-errors.ts` |
| `APP_URL=""` | URLs de retorno de Stripe relativas | `'' ?? x` es `''`. Usar `\|\|`, no `??` |
| `Math.round(n * 100)` | `0.145` → `14/100` | La deriva binaria. Usar `src/lib/dinero.ts` |
| Precios recalculados al convertir cotización | Una cotización de S/130 intentaba cobrar S/200 | Congelar precios y pasarlos **como argumento de función**, fuera del esquema Zod: en el cuerpo, el navegador podría vender a cualquier precio |
| Diagnóstico contando **filas** de `_prisma_migrations` | Una migración a medias se reportaba como aplicada | Filtrar `finished_at IS NOT NULL AND rolled_back_at IS NULL` |
| «Cualquier almacén activo» | Tras multi-sucursal, el cajero de otro local veía el almacén equivocado y cada cobro fallaba | `filtroAlmacen(ctx.branchId)` |
| Consulta de sesión en el proxy | 120-140 ms en cada navegación, invisible en local | El proxy corre cerca del USUARIO, no de la base, y `regions` no lo mueve |
| `sesion_bd;dur=0` escrito a mano | El «detector» de regresiones no detectaba nada | Un literal nunca cambia. Hay que MEDIR el tramo |
| `?? 'VENDEDOR'` para un rol ausente | Habría echado al login todas las sesiones abiertas al desplegar | Un dato ausente es «no se sabe», no «el mínimo» |
| `includes()` sobre el archivo en una prueba estructural | **Tres** falsos positivos: la palabra estaba en un comentario que explicaba justo lo contrario | No se arregla filtrando comentarios: se arregla con AST (`tests/ast.ts`) |

## Verificación en dos pasos (MFA)

- **Quién**: obligatoria para OWNER y ADMIN, opcional para el resto (tabla `ROLES_CON_MFA_OBLIGATORIO` en `features/seguridad/mfa-reglas.ts`; con varios roles basta uno). El cajero no se frena en el mostrador.
- **Cómo**: TOTP (RFC 6238, SHA-1, 6 dígitos, 30 s, ±1 paso) implementado con `node:crypto` en `lib/totp.ts` (sin dependencias; probado con los vectores del RFC) + 10 códigos de recuperación de un solo uso.
- **Almacenamiento**: el secreto va cifrado con AES-256-GCM (`PSE_MASTER_KEY`, AAD `mfa:<userId>`); los códigos de recuperación, solo como SHA-256 atado al usuario. Columnas `mfa*` en `users`.
- **Login**: `authorize` (el endpoint público) valida la contraseña y, si la cuenta tiene MFA, exige el código; lanza `CredentialsSignin` con código propio (`mfa_required`, `mfa_invalid`, `mfa_locked`) solo DESPUÉS de validar la contraseña. `loginAction` los traduce y el formulario pide el código.
- **Anti fuerza bruta / repetición**: el intento se reserva con incremento atómico (5 fallos → bloqueo de 15 min, las peticiones en vuelo no ganan otra tanda); el paso TOTP usado se reclama atómicamente (`mfaLastStep`) y un código de recuperación se consume con `array_remove` atómico.
- **Obligatoriedad**: `resolveTenantContext` marca `mfaPendiente`; `requireTenantContext` lanza `MFA_REQUIRED` (sirve también a las Server Actions) y el layout redirige a `/activar-mfa`, que vive fuera del panel y usa `requireIdentidad` (sin acceso a datos del negocio).
- **Restablecer**: un administrador puede restablecer el MFA de quien tenga menos poder (nunca el del dueño ni el propio); cierra las sesiones y queda auditado (`mfa.restablecer`). Si el DUEÑO pierde teléfono y códigos, no hay vía dentro de la app: hay que hacerlo desde la base (limpiar las columnas `mfa*` de su fila).

## Guías de remisión

- **Modelo:** `DispatchGuide` + `DispatchGuideItem` (claves foráneas compuestas `(tenantId, id)`; ambas en `TENANT_SCOPED`, la guía acotada por sucursal con `BRANCH_SCOPED`). Vinculada a `Sale` o `BranchTransfer`, o a ninguna.
- **Numeración:** scope `GUIA_REMISION`, serie `T` + número de la sucursal (T001), reclamada con `claimNextNumber` dentro de la transacción.
- **Integridad:** el control «no más de lo vendido/enviado» va DENTRO de la transacción, tras reclamar el número (la fila del contador se bloquea y serializa las emisiones de la serie). Si el control falla, el número vuelve. Una guía anulada no cuenta, pero su número no se reutiliza.
- **Permisos:** `guias.emitir` (dueño, administrador, vendedor, cajero, almacenero) y `guias.anular` (dueño, administrador). El contador solo consulta (`reportes.ver`).
- **Transmisión:** pendiente de proveedor (ver `docs/COMPLIANCE.md` §7). Estado `PENDIENTE` hasta entonces.
- **Pantallas:** `/guias` (listado y anulación), `/guias/nueva` (desde una venta, una transferencia o sin origen) y el enlace «Emitir guía de remisión» en `/comprobantes`.


## Facturación real, ubigeo y usos del cliente base

- **Modo fiscal** (`invoicing/modo-fiscal.ts`, puro): DEMO / ENSAYO / REAL / PAUSADO, derivado de `Tenant.isDemo`, `realBillingEnabledAt` y `realBillingPausedAt`. Los escribe SOLO `superadmin/facturacion-real-service.ts` (lo vigilan `tests/facturacion-real.ts` y `tests/modo-fiscal.ts` por AST). En ENSAYO `issueTaxDocument` numera en serie de PRUEBA (`TAX_BOLETA_PRUEBA`/`TAX_FACTURA_PRUEBA` → PB001/PF001) y marca `TaxDocument.isTrial`; esos documentos jamás se envían (`enviarComprobante` los rechaza antes de elegir proveedor). `elegirProveedor` solo deja pasar REAL (y la demo, al simulado). `invoicing/requisitos-fiscales.ts` exige sucursal completa al emitir con la facturación real habilitada.
- **Alarma de envío** (`invoicing/alarma-envio.ts`): cuenta solo los comprobantes REALES pendientes y la antigüedad del más viejo; umbrales por negocio, por entorno o de trabajo (24 h / 72 h, que NO son plazos de SUNAT). Barra en el panel para dueño/administrador y insignia en el panel maestro.
- **Ubigeo:** tabla global `ubigeos` (sin `tenantId`). Servicio de solo lectura con el cliente base; selector en cascada `UbigeoSelect` con respaldo de 6 dígitos mientras esté vacía. Carga con `scripts/cargar-ubigeo.ts` y los totales declarados por la fuente.
- **Aviso de `PSE_MASTER_KEY`:** ya no se muestra al dueño. Es un asunto de la plataforma y vive en `/api/diagnostics` (presencia y validez, nunca el valor).
- **Lista de usos del `prisma` base y del SQL directo:** `tests/prisma-base.ts`. Cada archivo que lo usa está inventariado con su motivo; añadir uno exige escribirlo ahí. El POS, el inventario, la facturación, las sucursales, las guías, el panel y la impresión no pueden usarlo, y ningún componente de cliente tampoco. (No hay RLS de Postgres: queda para después; esta lista es la red mientras tanto.)


## Cola de envío fiscal (outbox + worker)

- **Tabla `fiscal_dispatches`** (`FiscalDispatch`): una fila por documento a enviar. Se crea en la **misma transacción** que emite el comprobante REAL (`issueTaxDocument`), así que no hay comprobante sin fila ni fila sin comprobante. Los documentos de PRUEBA, la demo y el ensayo no se encolan; en pausa sí (esperan).
- **Reclamo atómico** (`cola-fiscal/repositorio.ts`, único archivo con SQL directo): una sola sentencia elige y marca la fila con `FOR UPDATE SKIP LOCKED`; dos workers jamás reciben la misma. **Lease** `lockedUntil` (2 min): si el worker se cae, la fila vencida la recupera el siguiente reclamo; si era el último intento pasa a AGOTADO. **Fencing**: cada cierre exige `lockedBy` + `EN_CURSO`, así que un worker lento no puede pisar a quien recuperó su fila.
- **Qué nunca se reclama:** negocios demo, sin facturación real habilitada o en pausa; y documentos de prueba (la consulta lo comprueba aunque alguien insertara la fila a mano).
- **Reintentos:** intento inmediato y, si falla, 1 min, 5 min, 30 min, 2 h y 12 h (`reglas.ts`). Tras el sexto fallo, **AGOTADO**: el comprobante sigue PENDIENTE (nunca se marca aceptado sin respuesta del proveedor), con alarma al dueño (barra) y al SuperAdmin (insignia) y reintento manual. Un rechazo del proveedor es una respuesta definitiva: no se reintenta. Un proveedor asíncrono (ENVIADO) pasa la fila a CONSULTAR.
- **Procesamiento:** cada fila se procesa con el cliente **acotado a su negocio** (`getTenantPrisma`); el envío interno (`enviarInterno`) no depende de permisos de usuario y audita con actor nulo y `origen: 'cola'`. La clave de idempotencia hacia el proveedor (`Idempotency-Key = RUC-tipo-serie-correlativo`) es la misma en cada intento.
- **Endpoint** `POST /api/fiscal/worker`: lo dispara un programador EXTERNO (QStash, n8n con cron…), no el cron de Vercel. Secreto compartido `FISCAL_WORKER_SECRET` (`Authorization: Bearer` o `x-worker-secret`), comparado en tiempo constante; sin secreto (o menor de 16 caracteres) responde 503 y no ejecuta. Responde **200 también sin trabajo**. Cada llamada procesa un lote con tope de tiempo derivado de `maxDuration` y de filas, y devuelve `restante: true` si queda más. Es seguro que se solape o se repita. La validación de firmas de QStash queda para más adelante.
- **Envío manual** («Enviar» / «Reintentar»): pasa por la **misma** cola (reclama la fila con lease), así que un clic y el worker no envían el mismo comprobante dos veces.
- **Alarma:** `estadoEnvioFiscal` cuenta los AGOTADO (siempre crítico, sin esperar umbrales de horas).

## Códigos de producto (`ProductCode`) y el resolvedor único

Un código (EAN-13/EAN-8/UPC, CODE128, QR propio o interno) tiene **un solo dueño** en todo el negocio: `(tenantId, code)` es único. Antes los códigos vivían en cuatro columnas (`barcode` y `qrCode` de producto y de variante) y dos cosas distintas podían compartir el mismo; el escaneo devolvía una cualquiera.

- **Tabla `product_codes`**: `productId`, `variantId?`, `presentationId?` (reservado para el paso 2, hoy siempre nulo y sin clave foránea), `code`, `type`, `isPrimary` (como mucho un principal por dueño, índice parcial). Claves foráneas compuestas con el negocio.
- **Transición (expand):** las columnas antiguas siguen y los escritores (alta exprés, importación de catálogo) mantienen la tabla en la misma transacción (`registrarCodigosProducto`). Un código que ya es de otro dueño se rechaza con `DUPLICATE_CODE`.
- **Resolvedor** (`inventory/codigos.ts › resolverCodigo`): consulta la tabla en UNA consulta y devuelve `{producto, variante, presentación, stock}`; si el código no está, cae a las columnas antiguas y al SKU. Un código con más de un dueño se devuelve como `ambiguo` y la pantalla lo dice: **nunca se adivina**. Solo productos y variantes activos.
- **Relleno** (`scripts/poblar-codigos.ts`): ensayo por defecto; `--ejecutar` inserta los códigos sin colisión. **No muta nada de lo antiguo**: los códigos con varios dueños se informan (SKU, nombre y columna de cada uno) y se quedan fuera hasta que una persona decida. Idempotente.
- **Auditoría** (`auditarCoherenciaCodigos`): cuenta productos sin su fila y filas cuyo código ya no está en las columnas de su dueño.
- **Limitación conocida:** `registerSale` cobra el precio del PRODUCTO aunque el código sea de una variante; la pantalla muestra ese mismo precio.

## Presentaciones y conversión de unidades

El stock vive **siempre en la unidad base** del producto (`Product.unitType`). Una *presentación* («Caja x 12», «Saco 42,5 kg») solo convierte: `cantidad base = cantidad ingresada × factor`, donde el factor es cuántas unidades base contiene UNA presentación.

- **`product_presentations`**: `name`, `unitType`, `factor Decimal(14,6)` (CHECK > 0), `salePrice`/`costPrice` opcionales (si faltan, manda base × factor), `isDefaultSale` (como mucho una activa por producto, índice parcial) e `isActive`/`deletedAt` (baja solo lógica). Un código de barras puede pertenecer a una presentación (`ProductCode.presentationId`).
- **Trazabilidad en `SaleItem`, `PurchaseItem` y `StockMovement`:** `presentationId`, `enteredQuantity` (lo tecleado) y `presentationFactor` (COPIADO al operar: si la presentación cambia, la línea no); en ventas y compras también `presentationName`. Las columnas van todas o ninguna, y **la base comprueba que `quantity = enteredQuantity × presentationFactor`** (CHECK). `quantity` sigue siendo solo la unidad base: no cambia el cálculo del stock.
- **Matemática (`inventory/conversion.ts`)**, pura, con enteros grandes (`bigint`) y escala, sin coma flotante:
  - cantidad base exacta; si no cabe en 4 decimales se **rechaza** (no se pierde mercadería en silencio);
  - fracciones por unidad: enteros para piezas, cajas, bolsas, rollos…; hasta 3 decimales para kilos, metros, litros y galones; se validan en la presentación Y en la unidad base;
  - `totalLinea = precio de presentación × cantidad ingresada`, redondeado UNA vez a céntimos, mitad hacia arriba. El precio por unidad base es derivado e informativo;
  - idempotente: recalcular con las propias salidas normalizadas da lo mismo. Se contrasta con `decimal.js` en 4000 casos aleatorios.
- **Todavía NO integrado:** ventas, compras y movimientos aún no escriben estas columnas (paso 3). El escaneo de un código de presentación ya resuelve `{producto, presentación}` pero el POS aún no la usa.


## Presentaciones en ventas y movimientos de stock (Paso 3)

- **El servidor no cree al cliente.** El cliente envía `presentationId`, `enteredQuantity` y la cantidad base `quantity`; el servidor carga la presentación guardada (`presentacion-linea.ts`), recalcula con `conversion.ts` y rechaza si no coincide. La base lo vuelve a exigir con el CHECK `quantity = enteredQuantity × presentationFactor` (en salidas, `enteredQuantity` lleva signo negativo).
- **Precio.** Con precio propio: total de línea = precio de la presentación × cantidad ingresada, redondeado una sola vez; el precio por unidad base es el derivado (precio ÷ factor). Sin precio propio: precio base × cantidad base. El precio se lee de la base al cobrar, nunca del cliente.
- **Stock.** Se mueve únicamente en unidad base; las columnas de presentación son trazabilidad. Entradas y salidas manuales aceptan presentación; AJUSTE (conteo absoluto) no.
- **Límites conocidos.** No existe servicio de compras (`PurchaseItem` tiene las columnas, nada las escribe); cotizaciones y pedidos siguen en unidad base; el XML fiscal sigue en unidad base (catálogo de unidades SUNAT ⚠️); variantes y presentaciones no se combinan; `registerSale` sigue cobrando el precio del producto en variantes.
- Pruebas: `tests/presentaciones-integracion.ts`.

### Pantallas (Paso 3b)

- **Carrito del POS.** La lógica pura vive en `src/features/pos/carrito.ts` (`brutoDe`, `descuentoDe`, `conContada`, `itemDe`, `mismaLinea`). Una línea de presentación guarda `quantity` (base, la que mueve el stock) e `ingresada` (lo que cuenta el cajero). Se agrupa por producto **y** presentación: una caja y sueltas del mismo producto son líneas distintas. `tests/presentaciones-pantallas.ts` comprueba que el total en pantalla es idéntico al que cobra `registerSale`.
- **Cotizaciones y pedidos a caja** siguen en unidad base: con una presentación en el carrito se bloquean con un mensaje claro (cobrar directo o quitarla), en vez de enviar el precio equivocado.
- **Hoja de ingresos** (`ScanToStockSheet`): con una presentación escaneada, ENTRADA/SALIDA cuentan cajas/bultos y envían `presentationId`, `enteredQuantity` y la cantidad base; AJUSTE sigue siendo un conteo absoluto en base. Al cambiar de tipo la cantidad vuelve a 1 para no mezclar unidades.
- No probado en real: cámara/lector físico y la interacción en navegador (solo la lógica y la estructura).

## PWA (Paso 4): instalable, caché estricta, sin escrituras sin conexión

- **Instalable.** `src/app/manifest.ts` (→ `/manifest.webmanifest`, inicio en `/pos`, `standalone`) + íconos PNG en `public/icons/` generados del logo existente (`aima-logo.jpg`, relleno negro; el «maskable» con más margen). `/manifest.webmanifest` y `/sw.js` son públicos en `route-access.ts` (el navegador los pide sin cookie).
- **Service worker (`public/sw.js`): solo estáticos públicos del mismo origen** (`/_next/static/*`, `/icons/*`, `/aima-logo.jpg`; GET, sin cabeceras RSC/Authorization). **Nunca HTML, navegaciones, `/api`, Server Actions ni RSC**, y una respuesta con HTML/JSON/RSC/`Set-Cookie` o que no sea 200 nunca se guarda. Lo que no está en la lista no pasa por el worker (va a la red). Sin precache ni página offline: en un celular compartido nada de una sesión queda en el equipo. Se registra solo en producción; `sw.js` se sirve con `no-cache`. Al subir `VERSION` borra las cachés anteriores.
- **Sin red = sin cobro ni stock.** `useEnLinea()` (`src/lib/en-linea.ts`) + franja fija «Sin red / Offline» en el layout raíz. En el POS se bloquean cobrar, cotizar, enviar a caja y emitir boleta/factura; en inventario, confirmar un movimiento y el alta exprés. Los botones se deshabilitan y las funciones se cortan antes de llamar al servidor.
- **Límite conocido:** `navigator.onLine` solo detecta equipo sin conexión; un wifi sin salida a internet figura «en línea». Ahí la protección es el servidor (la petición falla y se muestra su error; el cobro es idempotente).
- **No hay ESLint en el proyecto** (ni script `lint`): la comprobación estática es `tsc --noEmit` y `next build`. Añadirlo requeriría una dependencia nueva.
- Pruebas: `tests/pwa.ts` ejecuta el `sw.js` real en un sandbox (HTML/API/RSC/POST/otro origen/cookies, versiones), valida íconos (PNG con el tamaño declarado), proxy y cabeceras, y los bloqueos sin red.

## Fase 3, Paso 1: pagos mixtos correctos (`src/features/pos/pagos.ts`)

Antes de introducir la deuda (fiado), el dinero de una venta tiene que cuadrar al céntimo: **Σ pagos − Σ vuelto = total**.

- **Bug corregido (caja).** El vuelto solo se guardaba si el *primer* pago era efectivo. Con `[Yape 50, efectivo 60]` sobre 100 el vuelto de 10 se perdía y el cierre de caja (`fondo + efectivo − vueltos`) esperaba 10 de más en el cajón. Ahora el vuelto se reparte en las líneas de **efectivo**, en orden y sin pasar de lo que recibió cada una. Reproducido en `tests/pagos-mixtos.ts` antes de corregir (cajón esperado 160 en vez de 150).
- **Solo el efectivo da vuelto.** Si lo pagado con Yape/tarjeta/transferencia ya supera el total, se rechaza (`INVALID_DOCUMENT`); antes se aceptaba un sobrepago sin devolución registrada.
- **`CREDITO` ya no se acepta como pago** (esquema y servicio, con mensaje claro) hasta que existan cliente, límite y deuda (Pasos 2-3): aceptarlo equivalía a dar la venta por cobrada sin registrar a quién la debe. El valor sigue en el enum de la base.
- Las reglas son lógica pura en céntimos enteros (`resolverPagos`) y se aplican en `registerSale`, por donde pasan también el cobro de cotizaciones y de pedidos. Un rechazo no escribe nada ni gasta número de comprobante.
- La pantalla del POS cobra el total exacto con métodos que no son efectivo (el «recibido» solo cuenta en efectivo).
- **Datos históricos:** las ventas ya registradas con el bug conservan su vuelto mal guardado; los cierres de caja pasados no se recalculan.

### Auditoría histórica del vuelto (solo lectura)

`npx tsx scripts/listar-vueltos-historicos.ts [--negocio <slug>] [--desde AAAA-MM-DD] [--detalle]` (lógica en `src/features/pos/vueltos-historicos.ts`). Revisa las ventas COMPLETADAS y clasifica el vuelto mal guardado: **PERDIDO** (salió del cajón y no se registró; es el bug), **EXCESO** (se registró de más) y **SIN_EFECTIVO** (sobrepago con Yape/tarjeta: revisar a mano; no entra en la corrección). Por turno de caja muestra la diferencia registrada y la corregida (registrada + vuelto no registrado). No escribe ni recalcula nada; sale con código 3 si hay ventas afectadas. Un turno EN CURSO con ventas afectadas seguirá esperando de más hasta cerrarse.

## Fase 3, Paso 2: modelo de datos del crédito (fiado)

Migración **expand** `20261110120000_credito_cuentas_por_cobrar` (generada con `prisma migrate diff`, más los CHECKs a mano). Solo añade; no toca datos existentes.

- **`Customer`** (columnas nuevas): `creditTermDays` (plazo, 0–365, por defecto 30), `creditBlockedAt` (bloqueo manual), `creditBalance` (deuda viva: **caché** que se actualiza en la misma transacción que la cuenta, bajo bloqueo de la fila, y que una auditoría compara con Σ de las cuentas abiertas). `creditLimit` ya existía.
- **`Receivable`** (cuenta por cobrar, una por venta): `amount`, `paidAmount`, `dueDate`, estado `ABIERTA | PAGADA | ANULADA`, `voidedAt/voidReason`, y `reviewRequestedAt/reviewReason` para marcarla «pendiente de revisión» cuando se emite una nota de crédito sobre la venta. **«Vencida» no se guarda**: se deriva de `dueDate` en la zona del negocio.
- **`CustomerPayment`** (abono): método (nunca `CREDITO`), monto, turno de caja (obligatorio si es efectivo), clave de idempotencia única por negocio, anulación con quién/cuándo/por qué (nunca se borra).
- **`PaymentAllocation`**: cuánto de cada abono se aplicó a cada cuenta (única por abono+cuenta).
- **Aislamiento (mismo mecanismo de siempre, sin RLS de Postgres):** las tres tablas están en `TENANT_SCOPED` (deny-by-default) y toda referencia dentro del negocio —cliente, venta, sucursal, turno, abono, cuenta— es una **FK compuesta `(tenantId, id)`**: un negocio no puede enlazar nada de otro aunque el servicio fallara. Las únicas FKs simples son a `tenants` y a `users`. Nada se borra en cascada salvo borrar el negocio entero.
- **CHECKs** (la última defensa): línea/saldo ≥ 0 y plazo 0–365; un cliente con deuda viva no se da de baja; `0 ≤ paidAmount ≤ amount`; el estado dice la verdad (ABIERTA con saldo; PAGADA abonada por completo y cerrada; ANULADA con fecha y motivo); abonos positivos, nunca `CREDITO`, y en efectivo siempre con turno de caja. **Trampa evitada:** un CHECK que da `NULL` se da por cumplido (`length(NULL) > 0` es NULL), así que lo que no puede faltar se pide con `IS NOT NULL`; lo atrapó la prueba (una cuenta ANULADA sin motivo pasaba).
- **Pruebas:** `tests/credito-esquema.ts` (Parte A sin base: FKs compuestas, registro de aislamiento, CHECKs, trampa del NULL; Parte B contra la base: aislamiento entre negocios, CHECKs, únicos, borrados y borrado del negocio entero).
- **No incluido a propósito:** que el deudor de la cuenta sea el cliente de la venta no lo exige la base (necesitaría un trigger o una FK triple sobre `sales`); lo valida el servicio (Paso 3) y la auditoría de coherencia.

## Fase 3, Paso 3.0: la venta es idempotente (`Sale.idempotencyKey`)

**El hueco:** el POS enviaba un `idempotencyKey` que `registerSale` ignoraba (`Sale` no tenía columna de clave y `replayed` era siempre `false`). Un doble toque o un reintento por red lenta creaba **dos ventas**: otro número, otro descuento de stock, otro pago. Se había dado por supuesto lo contrario; las notas anteriores del PWA («el cobro es idempotente») eran incorrectas para ventas.

- **Migración expand** `20261110110000_venta_idempotencia`: `sales.idempotencyKey` (nulo) + único `(tenantId, idempotencyKey)` + CHECK de que no sea una clave en blanco. NULL no choca: las ventas sin clave siguen siendo válidas.
- **`registerSale`:** (1) busca la clave **antes de hacer nada** y, si existe, devuelve la venta registrada con `replayed: true` (así el reintento funciona aunque el mundo haya cambiado: producto desactivado, turno cerrado); (2) la guarda al crear; (3) dos envíos simultáneos los resuelve el índice único: el perdedor se deshace entero (venta, pagos, stock, número) y recibe la venta ganadora. Un P2002 solo se trata como reintento si de verdad existe una venta con esa clave.
- **La clave identifica el INTENTO.** El POS la crea al cobrar, la **reutiliza mientras el cobro falla** y la **renueva tras cada cobro exitoso** (`idemRef.current = null`). Reutilizarla con otro carrito devuelve la venta original.
- Un intento que falla (p. ej. sin stock) no quema la clave. Alcance: ventas, y por ende el cobro de cotizaciones y de pedidos, que pasan por `registerSale`. Los abonos de crédito tendrán su propia clave (Paso 3.3).
- Pruebas: `tests/venta-idempotente.ts` (reproduce el doble cobro, 8 envíos simultáneos, caja, aislamiento por negocio, la base). Tres mutaciones comprobadas.

## Fase 3, Paso 3.1: permisos, códigos de error y reglas de pago del crédito

Lógica pura; **no cambia el comportamiento de la venta**: `registerSale` valida el fiado pero todavía lo rechaza (`MENSAJE_SIN_FIADO`) hasta el subpaso 3.2, que es el que registra la deuda. Así este commit no reabre el hueco de dar una venta por cobrada sin cuenta por cobrar.

- **Permisos** (`src/lib/permisos.ts`): `credito.otorgar` (fiar; **opcional**, el dueño lo activa solo al CAJERO: el VENDEDOR no cobra y no tendría dónde usarlo), `credito.cobrar` (abonos; de fábrica al CAJERO), `credito.limite` (línea, plazo y bloqueo) y `credito.castigar` (dar de baja deuda, anular abonos), estos dos solo dueño y administrador. Almacenero y contador no tienen ninguno. Los dos de administración están **vedados al PIN de cajero** (`PERMISOS_FUERA_DEL_PIN`): un PIN de 4 cifras no sube líneas ni castiga deudas.
- **Códigos de error:** `CREDIT_LIMIT` (supera la línea; con límite, deuda, monto y disponible), `CREDIT_BLOCKED` (bloqueado, sin línea o de baja) y `CREDIT_CUSTOMER` (sin cliente identificado). Los dos primeros los lanzará el servicio de crédito (3.2).
- **`resolverPagos` con `CREDITO`** (`src/features/pos/pagos.ts`), todo estricto: una sola línea de crédito; **cliente obligatorio** (no hay fiado a «público general»); **nunca con FACTURA**; y el total **cuadra exacto, sin vuelto** (pagos + fiado = total). Devuelve `credito` (lo financiado). Orden de precedencia de los errores: varias líneas → sin cliente → factura → pagos insuficientes → fiado con sobrepago → vuelto que el efectivo no cubre.
- **Esquema:** `CREDITO` ya se acepta en la línea de pago, pero la venta con fiado exige `customerId` (aviso temprano al cajero). Que el cliente exista, tenga documento válido, no esté bloqueado y tenga línea lo decide el servicio, dentro de la transacción (3.2).
- **Pruebas:** `tests/credito-reglas.ts` (28; sin base de datos): matriz de permisos, PIN, errores, reglas y una propiedad de 8000 combinaciones contra un oráculo independiente. Seis mutaciones comprobadas.

## Fase 3, Paso 3.2: el fiado dentro de `registerSale` (`src/features/credito/credito-service.ts`)

- **Bloquear al cliente PRIMERO.** Toda operación que cambia la deuda de un cliente empieza con un `UPDATE` de su fila (`creditBalance += 0`), que devuelve la fila **ya bloqueada y fresca**. Dos cajas que fían al mismo cliente a la vez se serializan: la segunda espera, lee el saldo ya actualizado y se rechaza si no cabe. Es Prisma puro (sin SQL crudo, pasa por el aislamiento por negocio) y como todos los caminos de crédito bloquean al cliente antes de tocar cuentas o abonos, el orden de bloqueo es siempre el mismo: sin interbloqueos. Probado con 8 ventas simultáneas desde dos sucursales a una línea de 300: pasan exactamente 3; sin el bloqueo la deuda llegaba a 400.
- **`registerSale`:** tras crear venta y pagos —y **antes** del stock— `otorgarCredito` comprueba que se pueda fiar (de baja → sin DNI/RUC válido → bloqueado → sin línea → supera la línea), crea la `Receivable` (vence = hoy en la zona del negocio + plazo del cliente) y sube `creditBalance`; audita `credito.otorgado` con la deuda antes y después. Todo en la misma transacción: si el stock falla después, la deuda se deshace con la venta. Exige el permiso `credito.otorgar`.
- **Lo fiado no entra al cajón:** el pago queda como línea `CREDITO` (sin vuelto) y el arqueo solo cuenta EFECTIVO.
- **Reintento seguro:** el reintento de un fiado devuelve la venta original con su fiado (`credito` en el resultado, también cuando `replayed`) y no duplica la deuda.
- **`configurarCredito`** (`credito.limite`): línea, plazo (0–365) y bloqueo, auditado con antes y después. Bajar la línea por debajo de la deuda se permite (no se fía más hasta que pague); dar línea a un cliente sin documento válido, no.
- **Qué no hace todavía:** abonos y anulaciones (3.3), cierre de caja con abonos (3.4), pantallas (Pasos 4-5). Un fiado ya puede nacer, pero hasta el 3.3 no se puede cobrar: **no se debe desplegar el 3.2 solo** sin que el POS ofrezca el método (hoy la pantalla no lo ofrece, así que en la práctica nadie puede fiar hasta el Paso 4).
- Pruebas: `tests/credito-servicio.ts` (51): reglas puras, configuración, fiado total y mixto, 9 rechazos sin escrituras, atomicidad, reintento, concurrencia, una secuencia aleatoria contra un modelo independiente y la coherencia global (caché de deuda = Σ cuentas abiertas; lo fiado en pagos = Σ cuentas). Cinco mutaciones comprobadas.

## Fase 3, Paso 3.3: abonos, anulaciones, castigo y reglas SUNAT del fiado (`credito-service.ts`)

- **`registrarAbono`** (permiso `credito.cobrar`): bloquea al cliente primero, relee la clave de idempotencia ya con el bloqueo (el reintento, incluso simultáneo, devuelve el abono original sin duplicar) y reparte **FIFO por vencimiento** (`dueDate`, luego antigüedad, luego id) o sobre las cuentas que el cajero elija. Un abono mayor que lo adeudado en las cuentas elegidas, o que toda la deuda, se rechaza sin tocar nada. Un abono en efectivo exige turno de caja abierto y entra a esa caja. Crea `CustomerPayment` + `PaymentAllocation`, sube `paidAmount`, cierra las cuentas saldadas y baja `creditBalance` en la misma transacción.
- **`anularAbono`:** devuelve lo abonado a cada cuenta y a la deuda del cliente, y reabre la cuenta que había quedado PAGADA. Un abono en efectivo solo se anula mientras **su turno siga abierto** («un turno cerrado es inmutable»): después, el ajuste es un ingreso/egreso manual justificado por la administración. Si el reparto cayó en una cuenta ya dada de baja, se le devuelve lo abonado pero no se reabre.
- **`anularCuenta` (castigo,** permiso `credito.castigar`**):** da de baja una cuenta y quita **solo su saldo** de la deuda; lo ya abonado se conserva en el historial. El cliente castigado puede seguir pagando lo que sí debe.
- **Facturación (SUNAT):** una venta fiada **no admite FACTURA** (la factura a crédito exige datos de cuotas que todavía no se emiten): el servicio de facturación la rechaza con un mensaje que pide emitir boleta. Si se emite una **nota de crédito** sobre una venta fiada, `marcarRevisionPorNota` deja la cuenta «pendiente de revisión» con el número de la nota y su sustento (también si ya estaba PAGADA); el dueño la resuelve a mano (`credito.castigar`) o la descarta con `descartarRevision`. Nada se cancela solo.
- **Garantías:** todo en una transacción, auditado, con el aislamiento por negocio (`Receivable`, `CustomerPayment`, `PaymentAllocation` en `TENANT_SCOPED`).
- **Qué no hace todavía:** el cierre de caja y los reportes aún no muestran los abonos (3.4); la auditoría de coherencia con script (3.5); pantallas (Pasos 4-5).
- Pruebas: `tests/credito-abonos.ts` (63): esquemas, FIFO, cuentas elegidas, caja, permisos, idempotencia (6 simultáneos con la misma clave), concurrencia (6 abonos de 100 sobre deuda 300: pasan exactamente 3), turno cerrado, castigo, cliente eliminado, bloqueo de factura, nota de crédito y coherencia global. Ocho mutaciones comprobadas, todas detectadas.

## Fase 3, Paso 3.4: cierre de caja, reportes y ticket con el crédito

- **Qué entra al cajón y qué no.** `esperado = fondo + cobros en efectivo + abonos de deuda en EFECTIVO − vueltos`. El **fiado** no suma (no entró dinero) y un **abono por Yape/transferencia** tampoco (no es efectivo). Un abono anulado no cuenta.
- **Tres columnas congeladas** en `cash_sessions` (migración `20261111100000_caja_credito`, `DEFAULT 0`, CHECK `>= 0`): `creditSalesTotal` (lo fiado en el turno), `cashReceiptsTotal` (abonos en efectivo) y `otherReceiptsTotal` (abonos por otros medios). Se calculan al cerrar y no se recalculan: lo que el cajero firmó no cambia si mañana se castiga una deuda. Los turnos anteriores a la migración quedan en 0, que es lo correcto (no existían abonos ni fiado).
- **Una sola fuente de verdad:** `totalesDelTurno` + `efectivoEsperado` (`cash-service.ts`) los usan el cierre (que congela) y la consulta en vivo `currentCashSession` (que recalcula). Lo que se ve trabajando y lo que se firma salen de las mismas reglas.
- **Nada se cuela en un turno que se está cerrando.** `bloquearTurno` (`branches/queries.ts`) toma la fila del turno y devuelve su estado ya firme. El cierre lo toma **antes de sumar**; `registrarAbono` y `anularAbono` lo toman antes de escribir. Orden de bloqueos del crédito: cliente → turno (el cierre solo toma el turno: sin ciclos). Un abono en efectivo que llega durante el cierre espera, ve el turno cerrado y se rechaza; uno por otro medio queda sin turno; anular un abono de un turno que se cierra se rechaza. Dos cierres simultáneos: uno cierra y el otro ve «ya está cerrado».
- **Lo que NO cambia (decisión previa documentada):** una **venta** que llega durante el cierre sigue sin bloquear el turno (`registerSale` resuelve el turno antes de abrir su transacción para no fallar en hora punta); queda detectable porque Σ ventas ≠ `salesTotal`. Los abonos, que son nuevos y mueven dinero real, sí bloquean.
- **Ticket:** la línea `CREDITO` imprime «Crédito» y debajo «Vence el DD/MM/AAAA» (fecha del calendario del negocio, sin pasar por `Date`, para que un huso no la corra). No se imprime si la cuenta se dio de baja. El método `TARJETA_CREDITO` sigue rotulado «T. crédito»: no se confunde con el fiado. **Pendiente para el Paso 4:** el POS rotula `TARJETA_CREDITO` como «Crédito»; al ofrecer el fiado hay que renombrarlo.
- **Reportes:** `rendimientoDeCaja` y la pantalla de caja (cierre y último cierre) muestran fiado y abonos cuando existen. La auditoría `cash.close` guarda `fiado`, `abonosEfectivo` y `abonosOtros`.
- Pruebas: `tests/caja-credito.ts` (32): separación efectivo/fiado/abonos, columnas congeladas, turno cerrado inmutable, bloqueo del turno (cierre en marcha simulado con una transacción que lo retiene), rondas simultáneas, cierre sin crédito idéntico al de siempre, CHECK en base de datos, reporte, ticket y estructura. Once mutaciones comprobadas.
- **Despliegue:** esta migración es **aditiva** (3 columnas con `DEFAULT 0` + 1 CHECK): segura de aplicar en producción antes que el código.

## Fase 3, Paso 3.5: auditoría de coherencia del crédito (`auditar-credito`)

- **Qué es:** `src/features/credito/auditoria.ts` + `scripts/auditar-credito.ts`. **Solo lectura**: no escribe, no corrige, no recalcula. El crédito guarda la misma verdad en varios sitios (deuda del cliente = caché de sus cuentas; abonado = suma de repartos; el cierre congela totales); los CHECK de la base impiden estados imposibles pero no pueden comparar tablas. La auditoría las compara, en céntimos enteros.
- **Dos piezas:** `auditarDatosCredito` (función pura sobre datos ya leídos: permite probar cada regla con datos fabricados) y `auditarCoherenciaCredito(db)` (lee con el cliente Prisma **aislado por negocio** y llama a la pura).
- **Errores (el dinero no cuadra):** `DEUDA_CLIENTE` (deuda ≠ Σ saldos de cuentas abiertas), `ABONADO_CUENTA` (abonado ≠ Σ repartos de abonos no anulados), `REPARTO_ABONO` (Σ repartos ≠ monto del abono), `REPARTO_CLIENTE` (un abono paga la cuenta de otro cliente), `VENTA_FIADA_SIN_CUENTA`, `CUENTA_SIN_FIADO_EN_VENTA`, `MONTO_CUENTA_VENTA`, `CLIENTE_CUENTA_VENTA`, `CIERRE_ABONOS` (abonos congelados de un turno cerrado ≠ los enlazados a él).
- **Avisos (legítimo, pero alguien debe mirarlo):** `CIERRE_FIADO` (el fiado congelado ya no coincide con las ventas vigentes: una venta se anuló o llegó tras el cierre, decisión del 3.4), `VENTA_ANULADA_CUENTA_VIVA`, `REVISION_PENDIENTE` (nota de crédito sobre un fiado sin resolver).
- **Uso:** `npx tsx scripts/auditar-credito.ts [--negocio <slug>] [--detalle]`. Salida: `0` sin errores (los avisos no la cambian), `3` con errores, `1` fallo del propio script. Como el resto de scripts, apunta a la base que digan `.env.local`/`.env`; al ser de lectura es seguro correrlo contra producción **después** de desplegar el Paso 3. **Úsalo en el despliegue:** ejecutarlo justo después de aplicar las migraciones y de nuevo tras las primeras operaciones de crédito reales.
- Pruebas: `tests/credito-auditoria.ts` (29): 12 reglas con datos fabricados, un negocio real que fía/abona/anula/castiga/cierra y sale limpio, daños provocados a propósito y localizados, aislamiento entre negocios, el script con sus códigos de salida, y que auditar no cambia la base (ni filas ni `updatedAt`). Diez mutaciones comprobadas.

## Fase 3, Paso 4: el POS con pago dividido y fiado

- **Una sola fuente de verdad entre pantalla y servidor.** `pos/pagos-ui.ts` (puro) decide `FALTA / LISTO / ERROR` llamando a **`resolverPagos`**, la misma función con la que `registerSale` valida el cobro; así la pantalla nunca dice «listo» para que el servidor rechace, y los mensajes de error son literalmente los del servidor. `credito/reglas.ts` (puro) contiene `validarFiado`, `tieneDocumentoValido` y la ficha (`construirInfoCredito`, `motivoNoCabe`); `credito-service` las re-exporta. Ninguno de los dos importa Prisma ni nada de servidor: los puede importar el navegador. Probado con 2 000 casos al azar contra `resolverPagos`.
- **Ficha de crédito** (`infoCreditoCliente`, servicio + server action, **solo lectura**): línea, deuda, disponible, plazo, vencimiento si se fía hoy, deuda vencida y si se puede fiar (con el motivo del servidor). La ve quien tiene algún permiso de crédito; el cliente de otro negocio no existe para la consulta. **La mora es un aviso naranja, no un bloqueo** (decisión aprobada: el único bloqueo duro es la línea). La ficha es una foto: lo que decide es `otorgarCredito`, dentro de la transacción de la venta y con el cliente bloqueado; si otra caja fió mientras tanto, el cobro se rechaza con el mensaje real y la ficha se refresca.
- **Pantalla** (`PosTerminal` + `PanelPagos`, `FichaCredito`, `ReciboEmitido`):
  - **Cobro simple** de un toque, igual que siempre. «Dividir pago» abre un panel **dentro del bloque fijo del fondo** (sin pantalla aparte; sirve en móvil): hasta 5 líneas (el tope del servidor), «Falta cobrar», vuelto y errores en vivo. El botón Cobrar espera a «LISTO» y el cobro lo vuelve a comprobar.
  - **«Fiado por el saldo»**: una línea `CREDITO` que **vale siempre lo que falta** (se recalcula si cambia el carrito; nunca se teclea). Solo se ofrece con permiso `credito.otorgar`, cliente asignado y desde el POS; si no se ofrece por una razón evitable (sin cliente), la pantalla la dice; sin permiso se calla.
  - **Renombre:** la tarjeta pasa de «Crédito» a **«T. crédito»** (`pos/metodos.ts`, compartido con el panel y el ticket). «Crédito» queda solo para el fiado.
  - **Recibo:** «Fiado S/ X · vence DD/MM/AAAA · deuda total S/ Y» (la acción `registerSale` ahora entrega `credito`). **Factura deshabilitada** en una venta fiada, con el motivo a la vista; la boleta sí.
  - **Pedidos de la cola:** admiten pago dividido, **no fiado** (decisión aprobada): la pantalla no lo ofrece y **el servidor lo rechaza** (`convertQuoteToSale`: «el fiado se cobra desde el POS»), para que no dependa de que la interfaz se porte bien.
  - La clave de idempotencia se reutiliza al dividir: un reintento tras un corte de red no cobra dos veces. Sin red, el cobro (también el fiado) sigue bloqueado como cualquier otro.
- **Clientes nuevos desde el POS** nacen sin línea de crédito; la gestión de líneas llega con el Paso 5 (`credito.limite`).
- Pruebas: `tests/pos-pagos-ui.ts` (42) y `tests/pos-pantalla-fiado.ts` (36, componentes renderizados aislados con `renderToStaticMarkup`). Lo que **no** se prueba aquí: el comportamiento táctil real, el desplegable en un móvil y la impresión; para eso hace falta navegador/dispositivo.
- **Cierre (4.3) — revisión final.** Casos límite corregidos al revisar el diff completo: quitar al cliente con una única línea de fiado ya no deja el panel de pagos vacío (`quitarFiado`), y el refresco de la ficha tras un rechazo por crédito solo vale si el cajero sigue con el mismo cliente. Se detectó además que la acción `registerSale` no entregaba `credito` a la pantalla (corregido y cubierto por prueba).
- **Decisiones que quedan fijadas:** (1) el servidor es la autoridad: ocultar el fiado en la interfaz es comodidad, no seguridad (`otorgarCredito` exige `credito.otorgar` y el cliente bloqueado dentro de la transacción; `convertQuoteToSale` rechaza `CREDITO`). (2) La mora avisa, no bloquea. (3) Un cliente creado desde el POS no tiene línea hasta que el Paso 5 se la dé.
- **Qué NO está cubierto (hace falta navegador o dispositivo):** táctil real del panel desplegable en móvil (el bloque fijo del fondo tiene su propio scroll, `max-h-[85dvh]`, pero con el panel abierto no se ha medido en pantallas pequeñas reales), la impresión del ticket con «Vence el», el comportamiento sin red (se prueba por código y por render, no con la red cortada), y el flujo completo con lector de códigos.
- **Pendiente → Paso 5:** pantalla de clientes con `clientes.gestionar`, línea/plazo/bloqueo (`credito.limite`), cuentas por cobrar con antigüedad 0-30/31-60/61-90/+90, estado de cuenta, modal de abonos (con elección de cuentas), tarjeta en el panel y CSV. Las server actions de abonos, anulación, castigo y configuración de línea aún no existen (solo `infoCreditoCliente`).

## Fase 3, Paso 5: clientes y cobranza (pantallas)

- **Permisos** (`src/features/clientes/permisos.ts`, lista PURA que importan el servicio, las páginas, el menú y el panel: deciden con la misma):
  - `clientes.gestionar` (dueño y admin; vedado al PIN): crear, editar, dar de baja y reactivar clientes.
  - **Ver** clientes (lista, ficha, estado de cuenta, recibos): `clientes.gestionar`, `credito.cobrar`, `credito.limite` o `credito.castigar`. El cajero que cobra abonos ve, no edita.
  - **Ver la cobranza** (`/cobranza`, tarjeta del panel): lo anterior más `reportes.ver`. El contador revisa la cartera pero **no** ve la ficha de los clientes (los nombres no enlazan).
  - Línea, plazo y bloqueo siguen siendo de `credito.limite`; castigar deuda, anular abonos y resolver revisiones, de `credito.castigar`. Ocultar un botón es comodidad: **el servicio vuelve a decidir**.
- **Clientes** (`src/features/clientes/`): el documento no cambia si hay ventas; no se quita a quien tiene línea o deuda; la baja es lógica y se rechaza con deuda; editar y dar de baja **bloquean al cliente antes de leer** (como todo el crédito); el documento de un cliente de baja no se reutiliza (se dice «reactívalo»). La lista se ordena con el criterio del español en la aplicación (Postgres ordena por bytes y mandaría «Álvaro» tras la «Z») y pagina por cursor.
- **Abonos desde la ficha:** el modal calcula la **vista previa con `repartirAbono`, la misma función con que el servicio escribe**, y repite los mensajes del servidor (`mensajeAbonoExcede`, la regla de caja). La clave de idempotencia nace al abrir y se conserva en los reintentos. Las acciones de servidor solo delegan: no tienen lógica de dinero ni de permisos.
- **Cobranza** (`/cobranza`): «Vigente» aparte de la mora real en **días desde el vencimiento** (1-30, 31-60, 61-90, +90); lo que vence hoy sigue vigente. Se suma el **saldo**, no el monto. Ordenada por urgencia (mayor deuda vencida), no por alfabeto. Si la deuda guardada en los clientes no coincide con la suma de las cuentas, **lo avisa** en pantalla y en el panel.
- **Tarjeta «Por cobrar»** del panel: sale del mismo informe y solo aparece si hay deuda.
- **Estado de cuenta:** pantalla imprimible en **A4** (`/estado-de-cuenta/[id]`, grupo de rutas `(print-a4)` con su `a4.css`; su `@page` no contamina el ticket de 80 mm ni el panel) y CSV. Fechas como días del calendario del negocio, sin pasar por `Date`.
- **CSV** (`src/lib/csv-export.ts` + `respuesta-csv.ts`): separador `;`, BOM UTF-8, CRLF; las celdas de **texto** que empiezan por `= + - @` se neutralizan (inyección de fórmulas) y los montos negativos siguen siendo números; la respuesta es `attachment`, `no-store`, `nosniff` y con el nombre del archivo saneado. Cada descarga queda **auditada** (quién y cuántas filas).
- **Recibo de abono de 80 mm** (`/imprimir/abono/[id]`): comprobante INTERNO de caja (no un comprobante electrónico; el pie lo dice). Número `AB-AAAAMMDD-XXXXXX` (día del negocio + últimos 6 del id): estable pero no correlativo, porque no hay contador de recibos. La **deuda restante** se toma del registro de auditoría del propio abono, así que **reimprimir días después sigue diciendo lo que quedaba aquella tarde**. Un abono anulado imprime marca de agua y «RECIBO ANULADO» con su motivo. Se ofrece al cobrar y desde cada abono de la ficha.
- **Sin migraciones:** el Paso 5 es solo código; no toca el esquema.
- **Qué NO se probó en real (hace falta navegador, impresora o dispositivo):** táctil del modal y de la ficha en móvil; la tabla de cobranza de 7 columnas en pantallas pequeñas (tiene scroll horizontal propio); impresión real del A4 (cómo parte las hojas con muchas filas) y del recibo de 80 mm; que Excel abra el CSV; las acciones de servidor y las descargas con una sesión HTTP real (se prueban por estructura y por sus servicios).
- Pruebas: `clientes-servicio` (60), `cobranza` (47), `clientes-pantallas` (56), `cobranza-pantallas` (44), `recibo-abono` (29) y el resto de dominio de crédito. Mutaciones de cada subpaso comprobadas, contando como «detectada» solo la que hace fallar al menos una prueba de verdad.

## Fase 4: compras, proveedores y cuentas por pagar

### F4.1: modelo de datos (migración `20261112100000_compras_cuentas_por_pagar`)

- **Aditiva** (sin `DROP` ni `RENAME`): aplicable en producción **antes** que el código, como la de caja.
- **Tablas propias para lo que se debe a proveedores** (`account_payables`, `supplier_payments`, `supplier_payment_allocations`), separadas de las de clientes: el dominio del deudor y el del acreedor no se mezclan. Mismas reglas de aislamiento que el crédito: toda referencia dentro del negocio es una FK compuesta `(tenantId, id)`; entre tablas del negocio nada se borra en cascada; los tres modelos están en `TENANT_SCOPED`.
- **`Supplier`**: `paymentTermDays` y `payableBalance` (caché de Σ saldo de sus cuentas ABIERTAS, con CHECK ≥ 0 y «no se da de baja con deuda»). **`Purchase`**: `paymentCondition` (CONTADO/CREDITO), `dueDate`, `idempotencyKey` (única por negocio: recibir dos veces no duplica), quién la recibió/anuló, y **factura del proveedor única por proveedor** (la misma factura no se registra dos veces). **`CashSession`**: `supplierCashPaymentsTotal` (efectivo que SALE del cajón: restará al esperado) y `supplierOtherPaymentsTotal` (informativo).
- **CHECK en la base** (con la trampa del NULL cubierta): importes coherentes (`total = subtotal + IGV`); estados que dicen la verdad (BORRADOR / RECIBIDA / ANULADA y ABIERTA / PAGADA / ANULADA); crédito exige vencimiento y proveedor; **un pago en EFECTIVO exige turno de caja**; un pago nunca es `CREDITO`; anular exige quién, cuándo y por qué.
- **Decisión de costo (aprobada):** el costo de una compra se registra **SIN IGV** (valor de compra). El IGV de las compras es crédito fiscal, no costo de la mercadería; incluirlo inflaría el promedio ponderado y distorsionaría los márgenes. La compra guarda `subtotal`, `taxTotal` y `total` por separado. Al recibir, el costo del producto se actualiza por **promedio ponderado móvil** (F4.3). El costo ya cargado a mano no se toca.
- **Invariantes que el esquema no puede expresar** (los cubrirá la auditoría de coherencia del F4.4): que el proveedor de la cuenta sea el de la compra y que el de un pago sea el de la cuenta a la que se aplica.
- Pruebas: `tests/compras-esquema.ts` (93): estructura de la migración, aislamiento entre negocios, CHECK, índices únicos, borrados y cliente aislado, contra staging. Verificadas con 6 mutaciones **en la base** (quitar una garantía, comprobar que la prueba falla, restaurarla y comprobar que queda idéntica).

### F4.3: compras (`src/features/compras/`)

- **Ciclo de vida estricto:** `BORRADOR → RECIBIDA → ANULADA`. El borrador se arma y edita sin tocar stock, costos ni deuda; **recibir** y **anular** son las únicas operaciones con efecto, y cada una es UNA transacción: o todo, o nada.
- **Recibir:** (1) entra el stock con `applyStockMovement` (ENTRADA, origen `COMPRA`, con el costo base y la presentación como traza; el movimiento queda referenciado a la compra); (2) se recalcula el **costo promedio ponderado móvil SIN IGV** por producto (varias líneas del mismo producto cuentan juntas); (3) si es a crédito nace la **cuenta por pagar** por el TOTAL con IGV (lo que se le debe) y sube `Supplier.payableBalance` en el mismo monto. Al contado no hay deuda.
- **Costo (`costo.ts`, puro, BigInt):** `nuevo = (stock·costo + valorCompra) / (stock + cantidad)`, redondeo mitad hacia arriba a 4 decimales. Stock ≤ 0 o costo 0 («sin costo») no pesan: el costo pasa a ser el de la compra. Es el promedio del conjunto, sin importar el orden. La anulación usa la fórmula inversa con el valor de la compra (tratamiento estándar de una devolución a proveedor); si el stock restante es 0 o el resultado saldría negativo, el costo no se toca.
- **IGV:** se calcula sobre la base de cada tasa (como la factura del proveedor), no línea a línea; el costo nunca lo incluye. El servidor convierte la presentación (cajas → unidades base) y calcula totales; el cliente solo dice cuánto compró y a cuánto.
- **Anular:** BORRADOR → ANULADA solo con `compras.registrar`. **RECIBIDA** → exige además `stock.ajustar` (sale mercadería), rechaza si la cuenta tiene **pagos aplicados** (monto pagado o aplicaciones), devuelve el stock como `DEVOLUCION_PROVEEDOR` y **rechaza si algún producto quedaría en negativo — aunque la política del negocio permita negativos en ventas** (guardia propia; la transacción se deshace entera), revierte el costo, cierra la cuenta por pagar y baja la deuda del proveedor. La factura del proveedor queda libre para registrarse bien (el número original se conserva en las notas).
- **Concurrencia:** toda operación empieza **tomando la fila de la compra** (un `UPDATE` que espera a quien la tenga) y relee el estado firme. Orden fijo de bloqueos: compra → proveedor → productos (por id) → filas de stock. Recibir y anular son idempotentes **por estado** (repetirlos devuelve `replayed`); crear lo es por `idempotencyKey` (consulta previa + captura de la restricción única para los envíos simultáneos).
- **Permisos:** registrar/editar/recibir/anular = `compras.registrar`; ver la lista y el detalle = quien gestiona, registra o paga. El contador entra con las cuentas por pagar (F4.4).
- **Fuera de este subpaso (a propósito):** una compra AL CONTADO no genera egreso de caja (el pago a proveedor llega en F4.4 con el turno de caja); no hay pantallas (F4.5); la auditoría de coherencia de las cuentas por pagar es del F4.4.

### F4.4: pagos a proveedores, egreso de caja, antigüedad, estado de cuenta, CSV y auditoría (`src/features/por-pagar/`)

- **Pagar (`pagos.ts`)** es el guion de los abonos de clientes al revés: **bloquea al proveedor primero y luego el turno** (mismo orden que las compras: sin abrazos), reparte con `repartirAbono` (la MISMA función pura que la vista previa: lo que se ve es lo que se escribe), exige clave de idempotencia (UUID) y no deja pagar más de lo debido en las cuentas a las que se aplica. Sin cuentas elegidas, paga la más antigua primero. Solo `proveedores.pagar` (dueño y administrador; vedado al PIN).
- **Egreso de caja:** un pago en EFECTIVO exige un **turno abierto** y se **bloquea si supera el efectivo que debería haber** (`efectivoEsperado` + `totalesDelTurno`, calculados con el turno ya bloqueado: nada más mueve el cajón). Pagar exactamente lo que hay se permite; un centavo más, no. Los otros medios (transferencia, Yape…) no tocan el cajón y, si hay turno abierto, quedan enlazados a él para el reporte.
- **Columna congelada:** `efectivoEsperado` ahora resta `supplierCashPaymentsTotal`. El cierre de caja congela `supplierCashPaymentsTotal` y `supplierOtherPaymentsTotal` (pagos NO anulados del turno) junto con el resto, y los lleva a la auditoría del cierre. Un pago enlazado a un turno **cerrado no se anula** (el arqueo firmado no se reescribe); cerrar y pagar a la vez se serializan por el bloqueo del turno.
- **Anular un pago:** conserva la fila (quién, cuándo, por qué), reabre la cuenta saldada, restituye la deuda del proveedor y devuelve el efectivo al esperado. Idempotente por estado. **Ajuste a F4.3:** anular una compra solo se bloquea por pagos **vigentes**; el reparto de un pago anulado queda de historial y ya no aplica nada (antes habría bloqueado la compra para siempre).
- **Lectura (`informes.ts`):** antigüedad por proveedor (mismos tramos de mora que la cobranza: lo que no vence va en «Vigente»; «vence hoy» no está vencida), estado de cuenta con periodo, descargas CSV (BOM, `;`, protección de fórmulas, cada descarga auditada) y el resumen de la tarjeta «Por pagar» del panel, que sale del mismo informe. **Quién ve:** proveedores/compras/pagos **y `reportes.ver`** (el contador revisa la deuda sin poder pagar ni anular). No hay permiso nuevo.
- **Auditoría de coherencia (`auditoria.ts`, `scripts/auditar-compras.ts`):** solo lectura, todo ERROR. Compara la deuda del proveedor con sus cuentas, lo pagado con los repartos vigentes, el reparto con el monto del pago, el proveedor de cada pago/cuenta/compra (los invariantes que el esquema de F4.1 dejó para aquí), cada compra recibida con su entrada de stock (y la devolución si se anuló), y lo congelado de cada turno cerrado con sus pagos y con su propia fórmula del esperado. Salida 3 si hay errores.
- **Fuera de este subpaso (a propósito):** pantallas y rutas de descarga (F4.5/F4.6); la tarjeta del panel y el voucher; **«pagar al recibir»**: una compra al contado no tiene cuenta por pagar, así que registrar su egreso exigiría un cambio de esquema; se resolverá en la pantalla como «recibir a crédito con vencimiento hoy y pagar» (sin migración).

### F4.5: pantallas de proveedores y compras

- **Rutas:** `/proveedores` (lista con búsqueda y filtros por la dirección), `/proveedores/[id]` (ficha: deuda, cuentas abiertas, últimas compras, datos), `/compras` (lista por estado, búsqueda y, desde la ficha, filtrada por proveedor), `/compras/nueva`, `/compras/[id]` (detalle y acciones) y `/compras/[id]/editar` (solo borradores; una recibida o anulada vuelve a su detalle). Todas exigen sesión; las de lectura deciden con `puedeVerProveedores` y las de escritura con `compras.registrar`, con 404 si no. El menú gana «Proveedores» y «Compras» con la MISMA lista de permisos que sus páginas.
- **Lo que se ve es lo que se guarda:** `costo.ts` ya no depende de Prisma (BigInt puro, probado contra `Prisma.Decimal` con miles de casos al azar), así que el formulario calcula los totales de cada línea, el IGV por tasa y el total con las MISMAS funciones que el servidor (`borrador-ui.ts`). El servidor recalcula todo igualmente y no se fía de lo que manda la pantalla. El vencimiento sugerido es el mismo que pone el servidor por defecto (hoy del negocio + plazo del proveedor).
- **Recibir y anular piden confirmación** y explican qué mueven (stock, costo promedio, deuda). Anular una recibida solo aparece con `stock.ajustar`; si no, la pantalla explica por qué. El formulario usa una clave de idempotencia fija mientras está abierto (un doble toque no crea dos borradores).
- **El costo por línea** (costo unitario y total de cada producto) solo se muestra a quien tiene `productos.ver_costo` o `compras.registrar`; quien solo paga ve lo que dice la factura (los totales). La guarda de costos (`tests/costo.ts`) autoriza exactamente esos dos componentes.
- **Fechas:** la de una compra es la del negocio (zona del tenant), no la de UTC.
- **Límite conocido:** al reabrir un borrador, el costo por unidad de compra se reconstruye como total de la línea / cantidad (es lo que se guarda exacto); para cantidades muy grandes, volver a guardar sin tocar nada podría mover un céntimo el total de esa línea. La pantalla muestra el total recalculado antes de guardar.

### F4.6: cuentas por pagar (pantallas), pago, voucher, caja y «pagar al recibir»

- **`/por-pagar`** es la antigüedad de la deuda con proveedores (mismos tramos y mismo aspecto que «Por cobrar»), con descarga CSV. La ve quien ve proveedores **y el contador** (`reportes.ver`); el nombre del proveedor lleva a su ficha solo si quien mira puede abrirla, de modo que el contador ve la deuda pero no la lista de proveedores ni las compras (su menú no las muestra). Es la misma lista pura de permisos para el menú, la página y el servicio (`PERMISOS_VER_POR_PAGAR`).
- **Pagar** vive en la ficha del proveedor (**«Registrar pago»**, solo `proveedores.pagar` y con deuda). El modal es el de los abonos al revés: método, monto, referencia, «la más antigua primero» o cuentas elegidas, vista previa del reparto y de la deuda restante, y la clave de idempotencia nace al abrir y solo se renueva tras un pago hecho. La lógica (`pago-ui.ts`) es **pura y compartida**: el servidor usa la misma función de reparto y los **mismos mensajes** (pagar de más, sin caja, sin deuda), así que pantalla y servidor dicen lo mismo. La pantalla **no adelanta cuánto efectivo hay en el cajón** (el arqueo sigue ciego): un efectivo que no cabe lo rechaza el servidor diciendo cuánto hay.
- **Pagos del proveedor:** lista de los últimos con su voucher y, con `proveedores.pagar`, «Anular pago» con motivo. Un pago de un turno ya cerrado **no se ofrece para anular** (se explica); la pantalla adelanta la regla del servidor, que la sigue aplicando.
- **Voucher (80 mm)** en `/imprimir/pago-proveedor/[id]`: número `PP-AAAAMMDD-XXXXXX`, proveedor, método, monto, a qué compras se aplicó y la **deuda restante de aquel momento** (leída de la auditoría del pago, así reimprimir días después no cambia). Es un documento **interno**, no un comprobante electrónico, y lo dice; un pago anulado imprime marca de agua y motivo.
- **Caja:** el cierre muestra «Pagos a proveedores en efectivo» (restan al esperado) y, aparte, los pagados por otros medios, leídos de las columnas congeladas. Un negocio que no paga de caja no ve esas líneas.
- **«Pagar al recibir»** no es un flujo nuevo del servidor: es **recibir a crédito y pagar esa cuenta al instante**. En el diálogo de recibir una compra a crédito (con `proveedores.pagar`) hay una casilla; al recibir se abre el modal de pago ya apuntando a la cuenta recién nacida y por su total. Son dos operaciones atómicas e independientes: si el pago falla (p. ej. efectivo sin caja), la compra queda recibida con su deuda y se paga después. En el formulario, «Vence hoy (se paga al recibir)» prepara el borrador. Al contado no hay deuda, así que no hay egreso que registrar: la pantalla lo explica y dice cómo hacerlo.
- **Tarjeta «Por pagar» del panel:** solo para quien ve las cuentas por pagar y solo si hay deuda; sale del mismo informe que la pantalla.
- **Descargas CSV:** `GET /api/proveedores/por-pagar` y `GET /api/proveedores/[id]/estado-cuenta?desde=&hasta=`: sesión (401), permiso del servicio (403), proveedor inexistente (404), cabeceras de `respuestaCsv` (attachment, no-store, nosniff) y cada descarga auditada.
- **Fuera de este subpaso:** estado de cuenta de proveedor en A4 imprimible (hoy solo CSV); revisión final, barrido global y despliegue (F4.7).

### F4.7: cierre de la Fase 4

- **Qué quedó:** modelo (migración aditiva única), permisos (`proveedores.gestionar`, `compras.registrar`, `proveedores.pagar`), proveedores, compras (borrador → recibida → anulada con costo promedio ponderado sin IGV), pagos con egreso de caja y columna congelada, antigüedad, estado de cuenta, CSV, auditoría de coherencia (`scripts/auditar-compras.ts`), pantallas (`/proveedores`, `/compras`, `/por-pagar`), voucher de pago, tarjeta del panel y «pagar al recibir».
- **Invariantes que sostienen todo** (las vigila la auditoría): la deuda del proveedor es la suma de sus cuentas abiertas; lo pagado de una cuenta es la suma de los repartos de pagos vigentes; cada compra recibida dejó exactamente su entrada de stock (y su devolución si se anuló); un turno cerrado conserva sus pagos y su esperado congelados.
- **Cómo se despliega:** ver `docs/DESPLIEGUE-FASE4.md` (la migración la aplica el build de Vercel antes de compilar; rollback = redesplegar el anterior).
- **Fuera de la Fase 4 (a propósito):** órdenes de compra, devoluciones parciales, notas de crédito de proveedor, compras en dólares, PLE/SIRE, cheques/letras, estado de cuenta de proveedor en A4 imprimible.

## Fase 5: reportes y SUNAT

### F5.1 y F5.2: base de reportes y reportes de ventas (`src/features/reportes/`)

- **Rutas:** `/reportes` (centro) y `/reportes/ventas` (cuatro pestañas: por periodo, por vendedor, por medio de pago y cobros), más `GET /api/reportes/ventas/[tipo]` (CSV). Todo exige `reportes.ver`: dueño, administrador **y contador**; cajero, vendedor y almacenero no. Ninguno de estos reportes lee costos ni márgenes (eso será de `productos.ver_costo`, en F5.3).
- **El periodo** (`periodo.ts`, puro): días civiles **del negocio**, de la medianoche del primer día (incluida) a la del día siguiente al último (excluida). Una venta de las 23:59 en Lima es de ese día aunque en UTC ya sea mañana; dos periodos contiguos nunca se solapan ni dejan huecos; el día que cambia la hora dura 23 o 25 horas y sigue siendo un día. Presets (hoy, ayer, semana —desde el LUNES—, semana pasada, mes, mes pasado, últimos 30) y rango libre de hasta 366 días. Una dirección manipulada vuelve al periodo por defecto con un aviso, no con un error. Agrupación por día, semana (identificada por su lunes) o mes, automática según la longitud, y **sin huecos** (los días sin ventas salen en cero).
- **Definiciones** (las mismas en pantalla, CSV y pruebas), en `ventas-calculo.ts`, todo en céntimos enteros:
  - *Venta*: COMPLETADA, fechada por el día en que se completó. Anuladas, borradores y devueltas no cuentan.
  - *A crédito*: cuenta como venta el día de la operación; el fiado es un «medio» más. El abono posterior no es venta: es un cobro.
  - *Monto de un medio*: lo cobrado **menos el vuelto**, de modo que los medios de una venta suman su total. Si no suman (datos históricos), el reporte lo **avisa** con la diferencia en vez de esconderlo.
  - *Vendedor*: quien armó el pedido o la cotización de la que nació la venta (`Quote.userId`); si no viene de uno, quien la registró. Alternativa: «quien cobró en caja».
  - *Cobros*: el dinero que ENTRÓ: pagos de las ventas completadas (sin lo fiado, netos de vuelto) más abonos de deuda **no anulados**, por la fecha en que se cobraron.
- **Sucursales:** el cliente aislado acota ventas y pagos de ventas; los **abonos no se acotan solos**, así que el reporte de cobros los filtra por las sucursales del usuario (si no, un administrador de una sucursal vería los abonos de otra).
- **Lectura por lotes** de 1000 (orden estable por fecha e id): un periodo largo no se trae de golpe y ninguna venta se pierde ni se cuenta dos veces (probado con 2050).
- **CSV** es-PE (BOM, «;», punto decimal, protección de fórmulas ya existente), con fila de TOTAL. Cada descarga queda en la auditoría (`reporte.exportado`: quién, qué reporte, qué periodo, cuántas filas); una descarga denegada o fallida no deja registro. Sin dependencia nueva: no hay `.xlsx`.
- **Pruebas:** `reportes-periodo` (45), `reportes-calculo` (50, incluye la conciliación de 3000 ventas al azar: días = semanas = meses = por vendedor = por medio = total, **sin redondear antes de comparar**), `reportes-ventas` (42, contra la base) y `reportes-pantallas` (32).
- **Límite conocido:** el reporte «por vendedor» atribuye al creador del pedido/cotización; una venta directa se atribuye a quien la registró. Si el negocio quisiera comisiones por otra regla, hay que decidirla antes de usarlo para pagar.

### F5.3: rentabilidad — margen por producto, inventario valorizado y ABC (`rentabilidad-*.ts`)

- **Rutas:** `/reportes/rentabilidad` (pestañas margen, inventario, ABC) y `GET /api/reportes/rentabilidad/[tipo]` (CSV, `margen | inventario | abc`). El centro `/reportes` enseña cada tarjeta con su permiso.
- **Permiso: `productos.ver_costo` y nada más.** Revelan el costo del negocio. `reportes.ver` por sí solo NO abre rentabilidad, y `productos.ver_costo` por sí solo SÍ (un poder = un permiso nombrado; nunca la intersección de dos). Dueño, administrador y contador lo tienen; cajero, vendedor y almacenero no. El menú «Reportes» se muestra con cualquiera de los dos permisos (`puedeAlguno` solo decide visibilidad); la página y el servicio guardan cada reporte. Un contador al que se le deniega `productos.ver_costo` pierde rentabilidad aunque conserve `reportes.ver`.
- **Regla central: costo 0 = «no sé», nunca «gratis».** Una línea cuyo `unitCost` es 0 no entra al margen (ni su venta ni su costo): se lista aparte («Vendido sin costo») y la **cobertura** (venta con costo ÷ venta total) acompaña a todo margen, con un aviso visible y un enlace a `/costos`. Un producto sin ninguna línea con costo muestra «— sin costo», nunca un 100 %.
- **Definiciones:** venta neta = total de la línea sin IGV con la misma cuenta del POS (`redondearCentimos(total / (1 + tasa))`), de modo que Σ venta neta = Σ `Sale.subtotal` al céntimo; costo de línea = cantidad (unidad base) × `unitCost` de la venta; utilidad = venta neta con costo − costo; margen = utilidad ÷ venta neta con costo (sobre ventas, no sobre costo). Solo ventas COMPLETADAS por `completedAt` en la zona del negocio (las anuladas, borradores y devueltas no cuentan).
- **Inventario valorizado:** saldo positivo × `Product.costPrice` actual (sin IGV), **al día de hoy** (no hay historia de costos). Stock sin costo no se valoriza —no vale 0—: se cuenta y se avisa de que el total es menor al real. Los saldos negativos ni suman ni restan y se avisan. Se acota a mano a las sucursales del usuario (el stock no se acota solo).
- **ABC (Pareto):** ordena por venta neta o por utilidad; con umbrales A/B configurables (80/95 por defecto, `0 < A < B < 100`). El producto que **cruza** el umbral queda en la clase que llena. Valores ≤ 0 van a C y no suman al total. Por utilidad, lo vendido sin costo no se puede clasificar: queda fuera y se cuenta aparte (no se manda a C como si rindiera poco).
- **CSV:** como en ventas (BOM, `;`, anti-fórmulas) y con línea de auditoría `reporte.exportado` (`rentabilidad-<tipo>`). El inventario en CSV deja vacío el costo y el valor de lo que no tiene costo.
- **Pruebas:** `rentabilidad-calculo` (31, puras), `rentabilidad-servicio` (32, base), `rentabilidad-pantallas` (38). 42 mutaciones, todas detectadas.

### F5.5: registro de auditoría en pantalla (`src/features/auditoria/`)

- **Ruta:** `/auditoria` (menú «Auditoría»). Permiso nuevo y nombrado: **`auditoria.ver`** («Ver el registro de auditoría (quién hizo qué)»). Dueño y administrador lo tienen (el administrador lo hereda por ser «todo menos `config.fiscal` y `plan.gestionar`»); contador, cajero, vendedor y almacenero **no**, y **no es opcional de ningún rol** (nadie puede activárselo a otro). Está en `PERMISOS_FUERA_DEL_PIN`: un PIN de operador no lo abre aunque la sesión sea del dueño. Un administrador al que se le deniega el permiso pierde la pantalla. Sin el permiso la página es 404 y el servicio responde `FORBIDDEN_ROLE`.
- **Qué muestra:** los `AuditLog` del negocio (las filas sin negocio —acciones globales del dueño del SaaS— nunca salen), más reciente primero, con filtros por periodo (hora del negocio, máx. 366 días), tipo (categorías del catálogo, más «Otros»), quién y documento (`entityId`). Cada registro se despliega para ver acción técnica, IP, motivo, antes y después. Lo hecho durante una sesión de soporte lleva la marca «Soporte».
- **Paginación por cursor** (`instante|id`, 50 por página, «Ver más antiguos»): estable aunque entren registros nuevos y aunque varios compartan instante (probado con 126 registros en 3 instantes).
- **Catálogo (`catalogo.ts`):** etiqueta en español y categoría por acción. Una acción sin etiqueta **no se esconde**: aparece con su código en «Otros». `tests/auditoria-redaccion.ts` falla si el código escribe una acción nueva sin etiquetar, o si el catálogo guarda una que ya nadie escribe.
- **Secretos (`redaccion.ts`):** antes de salir del servicio, «antes» y «después» se redactan: se tapan los valores de claves con aspecto de secreto (contraseñas, tokens, hashes, certificados, claves SOL, API keys…), aunque estén anidadas, y los textos que parecen Bearer/JWT/llave privada; se recortan textos, arreglos y profundidad. Es una red de seguridad: lo correcto sigue siendo no anotar secretos.
- **Alcance conocido:** el registro no tiene sucursal, así que NO se acota por sucursal: un administrador asignado a una sola sucursal ve la auditoría de todo el negocio (como ya gestiona usuarios de todo el negocio). Si algún día se quisiera acotar, `AuditLog` necesitaría `branchId`.
- **Solo lectura; sin descarga CSV** (no se pidió; si se quisiera, debe pasar por la misma redacción). Mirar la auditoría no genera registro propio.
- **Pruebas:** `auditoria-redaccion` (22), `auditoria-servicio` (32, base) y `auditoria-pantallas` (18).

### F5.4: documento de compra estructurado y registros de ventas y compras (`compras/documento.ts`, `src/features/registros/`)

- **Migración `20261113100000_compras_documento` (aditiva, con `down.sql` ensayado):** `purchases` gana `docType` (enum `PurchaseDocType`: factura, boleta, nota de crédito, nota de débito, recibo por honorarios, otro), `docSeries`, `docNumber` (`VARCHAR(20)`, texto: los ceros cuentan) e `issueDate` (`DATE`, día del calendario). Todo nulo en las filas existentes. Dos CHECK: los cuatro **juntos o ninguno**, y serie/número solo `[A-Z0-9]` (el guion es el separador de la referencia). Índice `(tenantId, issueDate)`. Validada con la cadena completa en un esquema temporal (sin deriva) y con el `down.sql` (sin deriva respecto del esquema anterior).
- **`invoiceRef` se conserva:** con documento estructurado se compone «SERIE-NÚMERO» y el índice único (negocio, proveedor, `invoiceRef`) sigue impidiendo registrar dos veces el mismo documento. Sin él sigue valiendo la referencia libre. Anular una compra deja los cuatro campos y `invoiceRef` vacíos (libera el documento). Límite conocido: una nota de crédito con la misma serie y número que una factura del mismo proveedor colisionaría (en la práctica las series difieren).
- **Validación (`validarDocumento`, pura):** los cuatro o ninguno; mayúsculas y sin espacios; la emisión existe en el calendario, no es futura **en la hora del negocio** y no es anterior a 2000. ⚠️ No se asignan códigos del catálogo oficial de SUNAT: eso es F5.6.
- **«Completar documento» (`completarDocumento`):** sobre una compra **RECIBIDA**, exige `compras.registrar`, cambia solo esas columnas e `invoiceRef` (no líneas, costos, stock, deuda ni totales; probado) y deja auditoría `compra.documento` con el antes y el después. Sirve también para corregir. Un borrador se completa editándolo; una anulada ya no tiene documento.
- **Registro de ventas (`/reportes/registros`):** sale de `TaxDocument` (facturas, boletas, notas de crédito y débito), por fecha de emisión en la hora del negocio. **Quedan fuera** los comprobantes de ENSAYO (`isTrial`) y las notas de venta. Entran todos los estados, pero los **totales suman solo ACEPTADO y OBSERVADO** (observado = válido con advertencias); PENDIENTE, ENVIADO, RECHAZADO y ANULADO van a un **bloque de control** aparte (conteo e importe). La nota de crédito resta, la de débito suma. Alertas: factura sin RUC válido del cliente, moneda distinta de soles.
- **Registro de compras:** compras RECIBIDAS (no borradores ni anuladas) por la **fecha de emisión** del documento; sin documento, la de **recepción** marcada **provisional** (suma al total, pero se avisa al contador con el importe y el camino «Completar documento»). La nota de crédito de compra resta. Avisos de proveedor sin RUC o sin proveedor. Es el total de cada documento, no el costo de cada producto (el servicio no lee costos de producto).
- **Permiso y alcance:** `reportes.ver` (dueño, administrador, contador). Los comprobantes se acotan solos por sucursal (por su venta); las compras, que no se acotan solas, se acotan a mano por el almacén de las sucursales del usuario. Lectura por lotes de 1000 (probado con 1100 comprobantes y 1100 compras). CSV es-PE con importes **con su signo**, fila TOTAL y filas de CONTROL, protegido contra fórmulas y auditado (`reporte.exportado`, `registro-ventas` / `registro-compras`).
- ⚠️ **Pendiente de validación del contador:** qué estados suman, el trato de las notas y la fecha de las compras son decisiones de producto aprobadas por el dueño, no una norma. Los registros NO son el PLE.
- **Pruebas:** `compras-documento` (48), `registros-calculo` (24), `registros-servicio` (32, base), `registros-pantallas` (33).

### F5.7: conciliación fiscal (`src/features/conciliacion/`, `scripts/auditar-fiscal.ts`)

- **Qué es:** una auditoría de **solo lectura** que comprueba que ventas, comprobantes, numeración, envíos, notas de crédito y registros cuadran entre sí. Informa y nunca corrige; decide una persona. Sin migración. Pantalla `/reportes/conciliacion` (tarjeta en `/reportes`), descarga `GET /api/reportes/conciliacion` (CSV auditado, protegido contra fórmulas) y script `npx tsx scripts/auditar-fiscal.ts [--negocio slug] [--desde AAAA-MM-DD --hasta AAAA-MM-DD] [--detalle]` (salida 0 limpio, 3 con errores, 1 si falla o recibe una opción desconocida).
- **Permiso y alcance:** `reportes.ver` (dueño, administrador, contador), vía `informeConciliacion`. El núcleo `calcularConciliacion` NO comprueba permisos (lo usa el script, que corre sin usuario como los demás auditores); ninguna página ni ruta lo llama directo (lo vigila una prueba). Ventas y comprobantes se acotan solos por sucursal; compras, contadores de numeración y envíos agotados se acotan a mano por las sucursales del usuario.
- **El puente ventas → comprobantes:** cada venta completada del periodo cae en UNA fila: nota de venta (sin comprobante por diseño) o con comprobante —válido (aceptado u observado), pendiente/enviado, rechazado, anulado, de ensayo, o «pide boleta/factura y no la tiene»—. Manda lo emitido: una venta que pidió nota de venta pero tiene comprobante cuenta como con comprobante. La **diferencia sin explicar debe ser 0**; si no, es un error. Las ventas **anuladas y devueltas** del periodo van en líneas informativas propias (no suman en ventas completadas, como en todos los reportes).
- **Comprobaciones:** (1) comprobante vs venta: base, IGV y total idénticos (se copian al emitir); (2) ventas anuladas o devueltas que conservan un comprobante **vivo** (aceptado, observado, pendiente o enviado) sin nota de crédito que lo neutralice —total, o notas no rechazadas que sumen el total—; (3) facturas sin RUC de 11 dígitos; (4) pendientes, enviados y rechazados, y envíos que agotaron sus reintentos; (5) numeración por serie real: números saltados (contando desde el arranque del contador) y contador atrasado (repetiría un número) o adelantado; las series de PRUEBA no cuentan; (6) notas de crédito que suman más que su comprobante o apuntan a otra venta; (7) el registro de ventas y el de compras contra un **cálculo independiente desde agregados de la base** (la nota de crédito resta; solo aceptados y observados suman); (8) compras con fecha provisional, proveedor sin RUC o sin proveedor; (9) informativos: modo ensayo/demo, ventas anuladas/devueltas y diferencia entre la fecha de la venta y la de emisión de su comprobante.
- **Niveles y ⚠️ umbrales operativos:** ERROR / ADVERTENCIA / INFO. Para lo **pendiente de emitir o de enviar**: menos de 24 h no es un hallazgo; **≥ 24 h advierte; ≥ 72 h es error** (`UMBRAL_ADVERTENCIA_HORAS`, `UMBRAL_ERROR_HORAS`). **No son plazos de SUNAT**: son un criterio operativo aprobado por el dueño, marcado con ⚠️ en la pantalla y pendiente de validar con el contador. Con el envío en **pausa** lo pendiente pasa a información (espera por decisión del dueño); lo enviado sin respuesta no.
- **Ensayo y demostración:** un negocio sin facturación real (modo ENSAYO) o en DEMO no tiene comprobantes con valor fiscal: sus hallazgos **nunca pasan de INFO** y el resultado es «Sin comprobantes reales que conciliar en este periodo.» (estado calmado, sin alerta). Los comprobantes de prueba (`isTrial`) no entran a ninguna comprobación real, ni al cálculo independiente.
- **Límites conocidos:** no distingue un rechazado ya resuelto con otro comprobante (solo advierte); el estado «ANULADO» de un comprobante viene del proveedor y no se cruza con la venta; la numeración se revisa sobre toda la historia de la serie, no por periodo; los envíos pendientes se leen hasta 2000 comprobantes abiertos.
- **Pruebas:** `conciliacion-calculo` (67), `conciliacion-servicio` (54, base y script real en consola), `conciliacion-pantallas` (25).
