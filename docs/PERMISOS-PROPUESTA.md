# Fase B — Permisos, roles y sesiones

> **Estado:** la matriz está **aprobada e implementada** (`src/lib/permisos.ts`,
> 26 permisos). Este documento conserva el razonamiento. Los tres permisos
> añadidos tras la aprobación inicial:
>
> | Permiso | Quién | Por qué |
> |---|---|---|
> | `caja.cerrar_ajeno` | DUEÑO, ADMIN | Sustituye a la intersección `abrir_cerrar` ∩ `arqueo`, que con roles múltiples dejaba cerrar el cajón ajeno a un CAJERO + CONTADOR |
> | `comprobantes.estado_manual` | DUEÑO, ADMIN | Declarar a mano la respuesta de SUNAT no es lo mismo que anular. Motivo obligatorio y auditoría |
> | `stock.transferir_solicitar` | todos menos CONTADOR | Pedir ≠ despachar. Ciclo: solicitar → aprobar → despachar → recibir |

Actualizado con tus decisiones. **Nada de esto está implementado**: es para tu
OK antes de programar.

Tus cuatro decisiones, recogidas:

| | Decidido |
|---|---|
| Modelo | **Permisos nombrados**; los roles son paquetes predefinidos |
| Sucursales | **Un rol por usuario** + lista de sucursales permitidas. No rol por sucursal |
| Nombres de rol | **No renombrar** `VENDEDOR` |
| Cierre remoto | Surte efecto en la **navegación siguiente** |

---

## 1. Catálogo de permisos

Tu lista, con la correspondencia al código de hoy. 18 permisos.

| Permiso | Qué habilita | Hoy lo controla |
|---|---|---|
| `ventas.crear` | Armar el carrito y dejar un pedido pendiente | `hasRole(VENDEDOR)` |
| `ventas.cobrar` | **Cerrar** la venta y recibir el dinero | — *(hoy va junto a crear)* |
| `ventas.anular` | Anular una venta ya cobrada | — *(no existe)* |
| `ventas.descuento` | Descuento de línea, **con tope % por rol** | — *(sin tope)* |
| `cotizaciones.crear` | Guardar y convertir cotizaciones | `hasRole(VENDEDOR)` |
| `caja.abrir_cerrar` | Abrir y cerrar turno | `hasRole(VENDEDOR)` |
| `caja.arqueo` | Ver descuadres, incluidos los de turnos ajenos | — |
| `productos.ver_costo` | **Ver costo y margen** | ⚠️ hoy por rango |
| `productos.editar_precio` | Cambiar precio de venta | `hasRole(ALMACENERO)` |
| `stock.ajustar` | Conteo físico (sobrescribe el saldo) | `hasRole(ADMIN)` |
| `stock.transferir_despachar` | Despachar a otra sucursal | `hasRole(ALMACENERO)` |
| `stock.transferir_recibir` | Recibir y contar lo que llega | `hasRole(ALMACENERO)` |
| `reportes.ver` | Reportes de venta y caja | — |
| `comprobantes.emitir` | Boleta y factura | `hasRole(VENDEDOR)` |
| `comprobantes.anular` | Nota de crédito | ⚠️ **no implementada** |
| `usuarios.gestionar` | CRUD de usuarios e invitaciones | `hasRole(ADMIN)` |
| `sucursales.gestionar` | Alta y edición de sucursales | `hasRole(ADMIN)` |
| `config.fiscal` | Correlativo inicial, series, certificado, Clave SOL | `hasRole(ADMIN)` |

### 🔴 `productos.ver_costo` oculta el costo también en API y exportaciones

Lo pediste explícitamente y es el permiso con más superficie: el costo no vive
solo en una pantalla.

**Dónde hay que filtrarlo, todo:**

| Superficie | Qué expone hoy | Qué hay que hacer |
|---|---|---|
| `Product.costPrice` | el campo | quitarlo del `select` sin el permiso |
| `SaleItem.unitCost` | costo congelado al vender | ídem |
| `/api/...` que devuelvan productos | el campo en el JSON | ídem |
| Exportación CSV del catálogo | columna de costo | omitir la columna |
| Importación CSV | **acepta** columna de costo | ⚠️ rechazar el archivo si trae costo |
| Reportes de margen | margen = precio − costo | el margen **revela** el costo |
| Ticket de 80 mm | no lo imprime | ✅ ya correcto |

**Cómo propongo implementarlo** para que no se escape por un `select` nuevo:
un helper `selectProducto(ctx)` que **devuelva** el `select`, en lugar de
escribirlo a mano en cada consulta. Más una **prueba AST** que falle si algún
archivo pone `costPrice: true` o `unitCost: true` literal en un `select` sin
pasar por el helper.

> El margen merece una nota: en un reporte, `margen %` permite **deducir** el
> costo a partir del precio, que sí es visible. Así que `reportes.ver` sin
> `productos.ver_costo` tiene que ocultar las columnas de margen, no solo las
> de costo. Si no, el permiso es decorativo.

---

## 2. Matriz rol × permiso

Seis roles. **Un usuario puede tener varios**, y entonces se queda con la
**unión** de sus permisos.

| Permiso | DUEÑO | ADMIN | VENDEDOR | CAJERO | ALMACENERO | CONTADOR |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| `ventas.crear` | ✅ | ✅ | ✅ | ✅ | — | — |
| `ventas.cobrar` | ✅ | ✅ | **❌** | ✅ | — | — |
| `ventas.anular` | ✅ | ✅ | — | — | — | — |
| `ventas.descuento` | ✅ **sin tope** | ✅ **sin tope** | ⚙️ **tope %** | ⚙️ **tope %** | — | — |
| `cotizaciones.crear` | ✅ | ✅ | ✅ | ✅ | — | — |
| `caja.abrir_cerrar` | ✅ | ✅ | — | ✅ | — | — |
| `caja.arqueo` | ✅ | ✅ | — | — | — | ✅ |
| **`productos.ver_costo`** | ✅ | ✅ | **❌** | **❌** | **❌** | ✅ |
| `productos.editar_precio` | ✅ | ✅ | — | — | ⚙️ | — |
| `stock.ajustar` | ✅ | ✅ | — | — | ⚙️ | — |
| `stock.transferir_despachar` | ✅ | ✅ | — | — | ✅ | — |
| `stock.transferir_recibir` | ✅ | ✅ | — | — | ✅ | — |
| `reportes.ver` | ✅ | ✅ | — | — | **❌** | ✅ |
| `auditoria.ver` (F5.5) | ✅ | ✅ | — | — | — | **❌** |
| `comprobantes.emitir` | ✅ | ✅ | — | ✅ | — | — |
| `comprobantes.anular` | ✅ | ✅ | — | — | — | — |
| `usuarios.gestionar` | ✅ | ✅ | — | — | — | — |
| `sucursales.gestionar` | ✅ | ✅ | — | — | — | — |
| **`config.fiscal`** | ✅ | **❌** | — | — | — | — |
| *(gestión del plan)* | ✅ | **❌** | — | — | — | — |

✅ concedido · — no concedido · ❌ **denegado explícitamente** · ⚙️ **activable
por el dueño, apagado de fábrica**

### Lo que cambia respecto de hoy

| Cambio | Hoy | Con la matriz |
|---|---|---|
| **El almacenero deja de ver costos** | los ve, por estar «por encima» del vendedor | ❌ denegado |
| **El almacenero deja de ver reportes de ventas** | los vería por rango | ❌ denegado |
| **El vendedor deja de cobrar** | cobra | ❌ denegado; deja pedido pendiente |
| **El administrador deja de tocar lo fiscal** | puede | ❌ `config.fiscal` solo DUEÑO |
| `CONTADOR` existe | no existe | nuevo, solo lectura |

⚠️ **Dos de estos son incompatibles con lo que ya hay desplegado.** Hoy
`fijarArranqueSerie` exige `hasRole(ADMIN)`, y con la matriz pasa a exigir
`config.fiscal`, que el ADMIN **no** tiene. Si tienes un administrador que hoy
configura series, dejará de poder. **Dímelo si eso te rompe algo.**

### ⚙️ El tope de descuento

`ventas.descuento` no es sí/no: lleva un **porcentaje máximo por rol**.

```
RolePermission { tenantId, role, permiso, concedido, limite? }
                                                     └─ 10 = hasta 10 %
```

- DUEÑO y ADMIN: sin tope.
- VENDEDOR y CAJERO: **apagado de fábrica**; el dueño lo activa y pone el tope.
- Se comprueba en el **servidor**, dentro de la transacción de la venta. Un
  tope que solo valide el navegador no es un tope.

---

## 3. Sucursales: un rol, varias sucursales permitidas

`UserBranch` ya existe y ya dice a qué sucursales entra cada usuario. **No se
toca el modelo de rol.**

Lo que falta: que **toda consulta respete esa lista**, no solo la sucursal
activa. Hoy `filtroAlmacen(ctx.branchId)` acota a la activa, que es correcto
para operar, pero un reporte consolidado o un buscador de productos podría
leer sucursales que el usuario no tiene asignadas.

**Propuesta:** `ctx.branchIds` (todas las permitidas) junto a `ctx.branchId`
(la activa), y una **prueba AST** que falle si una consulta de varias
sucursales no filtra por `branchIds`.

### Preparado para migrar después, sin romper datos

Lo pediste, y la forma de conseguirlo es que el rol **ya se lea por una sola
función**:

```ts
function rolEfectivo(ctx: TenantContext): Role     // hoy: ctx.role
function permisos(ctx: TenantContext): Set<Permiso>
```

El día que quieras rol por sucursal, se añade `UserBranch.role` nullable
—nulo significa «usa el de User», así que **ningún dato existente cambia**— y
solo `rolEfectivo` se modifica. Si en cambio los 29 `hasRole(ctx.role, …)`
siguen repartidos, esa migración vuelve a ser el repaso que acabas de
descartar. **Encapsularlo ahora es lo que hace baratа la migración luego.**

---

## 4. ⚙️ Flujo vendedor → cajero: cómo encaja con las cotizaciones

Pediste que lo proponga antes de construirlo. Hay tres caminos y **el tercero
es el que recomiendo**.

### El problema

El vendedor atiende el mostrador y arma el pedido; el cajero cobra. Entre los
dos hace falta un objeto que signifique «esto está listo para cobrar, con
estos precios».

### (a) Reusar `Quote` tal cual

Ya existe, ya congela precios, ya se convierte en venta.

❌ **No sirve**, y por una razón concreta: una cotización es un documento *para
el cliente*, con validez de días y que **no reserva stock**. Un pedido en el
mostrador es *interno*, de validez de minutos, y el cliente está esperando.
Meter los dos en la misma tabla mezcla «presupuesto que mandé por WhatsApp
hace tres días» con «lo que el señor tiene ahora en el mostrador», y el
listado de cotizaciones se vuelve inútil para las dos cosas.

### (b) Tabla `Pedido` nueva

Limpio conceptualmente, pero duplica `Quote` casi entero: cabecera, líneas con
precio congelado, conversión a venta, correlativo. Y duplicar la conversión a
venta significa duplicar **la congelación de precios**, que ya nos dio un bug
(una cotización de S/130 intentó cobrar S/200).

### ✅ (c) `Quote.tipo` — recomendado

Un campo que distingue el propósito, reusando toda la mecánica probada:

```prisma
enum QuoteKind {
  COTIZACION   // documento para el cliente, validez en días
  PEDIDO       // interno, mostrador, validez en minutos
}
```

| | COTIZACION | PEDIDO |
|---|---|---|
| Quién lo crea | cualquiera con `cotizaciones.crear` | `ventas.crear` |
| Quién lo cobra | cualquiera con `ventas.cobrar` | ídem |
| Validez por defecto | 7-15 días | **30-60 min** |
| Serie | `C001` | `P001` (serie propia) |
| Sale en `/cotizaciones` | sí | **no**: sale en una bandeja del POS |
| Reserva stock | no | **no** *(ver abajo)* |
| Se imprime | sí, 80 mm | opcional |

**Por qué reusa lo probado:** `registerQuote` y `convertQuoteToSale` ya
congelan precios y ya pasan los precios como argumento de función —fuera del
esquema Zod— para que el navegador no pueda imponerlos. El pedido hereda eso
sin escribir una línea nueva de lógica de dinero.

**Lo que hay que añadir:**
1. `QuoteKind` + serie `P001` derivada de la sucursal (la mecánica ya existe).
2. Bandeja «pedidos pendientes» en el POS del cajero, de su sucursal.
3. Caducidad automática: un pedido de ayer no se cobra a los precios de ayer.
4. `ventas.cobrar` separado de `ventas.crear`.

⚠️ **La decisión que te toca: ¿el pedido RESERVA stock?**

- **No reservar** (lo que propongo): más simple y consistente con la
  cotización. Riesgo: dos vendedores arman pedidos del último saco de cemento
  y el segundo falla al cobrar. El POS ya sabe gestionar eso —tiene venta
  forzada— pero es una conversación incómoda en el mostrador.
- **Reservar**: necesita stock comprometido, caducidad que lo libere, y un
  proceso que limpie reservas huérfanas. Es un subsistema, no un campo.

Para una ferretería con un mostrador, **no reservar**. Si tienes varios
vendedores sobre el mismo inventario escaso, cambia la respuesta.

---

## 5. PIN de cajero

Recogido lo que pediste.

| | |
|---|---|
| Qué es | 4-6 dígitos, `User.pinHash` con bcrypt |
| Para qué | Relevo de turno en el mismo dispositivo |
| Alcance | **Solo identifica; NUNCA eleva permisos** |
| Bloqueo | **5 intentos fallidos** → bloqueado |
| Desbloqueo | **Solo DUEÑO o ADMINISTRADOR** |
| Auditoría | **Cada uso**, acierto o fallo |

🔴 **La regla que lo hace defendible:** el PIN identifica en un dispositivo ya
autenticado; no autentica desde cero.

- Solo funciona si ya hay una sesión válida **de ese negocio** en el dispositivo.
- Solo entre usuarios de **la sucursal activa**.
- **No** da acceso a `/sucursales`, `/mi-plan` ni a `usuarios.gestionar`: para
  eso hay que entrar con contraseña.
- El bloqueo es **por usuario**, no por dispositivo: así no se puede bloquear
  al cajero de la caja de al lado probando su PIN.

Sin esas condiciones, 4 dígitos serían una contraseña de 10 000 combinaciones
para entrar a un sistema con dinero dentro.

---

## 6. Sesiones por dispositivo

```
DeviceSession { id, userId, tenantId, label, userAgent, ip,
                lastSeenAt, createdAt, revokedAt? }
```

El `id` viaja en el JWT como `sid`. Revocar = poner `revokedAt`.

**Cierre en la navegación siguiente** (aprobado): `revokedAt` se añade al
`select` que el layout **ya hace**, así que el coste es **cero consultas
nuevas**. Una sesión revocada muere en el siguiente clic, no en el siguiente
instante.

⚠️ **Dónde no alcanza, y conviene decirlo:** una Server Action en curso en una
pestaña ya cargada se completa. Para cortar también eso habría que comprobar
`revokedAt` en cada escritura — una consulta por escritura, no por navegación.
Si quieres eso para operaciones de dinero (cobrar, anular), dímelo: es un
añadido pequeño y acotado a esas acciones.

---

## 7. Orden de implementación

1. **Catálogo de permisos + matriz + `can(ctx, permiso)`**, con prueba AST que
   falle si un servicio comprueba el rol a mano en vez de pedir el permiso.
2. `CONTADOR` al enum (migración trivial; sin renombrar nada).
3. **`productos.ver_costo` en toda la superficie**: helper de `select`, API,
   exportación, importación, márgenes. Con su prueba AST.
4. `ctx.branchIds` y el filtro en consultas multi-sucursal.
5. CRUD de usuarios + invitaciones por token con caducidad.
6. Sesiones por dispositivo con cierre remoto.
7. PIN de cajero con bloqueo y auditoría.
8. `ventas.cobrar` separado + `QuoteKind.PEDIDO` + bandeja del cajero.
9. **MFA al final**, como pediste.

---

## Lo que necesito de ti

1. **¿Apruebas la matriz?** En particular los cuatro ❌ que **quitan** permisos
   que hoy existen: almacenero sin costos, almacenero sin reportes, vendedor
   sin cobrar, y **administrador sin `config.fiscal`** — este último afecta a
   quien hoy configure series.
2. **¿El pedido reserva stock?** (§4) Recomiendo que no.
3. **¿Los topes de descuento por rol** salen apagados de fábrica para VENDEDOR
   y CAJERO, o prefieres un valor inicial?
4. **¿Quieres comprobar la revocación también en cada escritura de dinero**
   (cobrar, anular), o te vale solo en la navegación? (§6)
