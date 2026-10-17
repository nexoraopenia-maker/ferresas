# Fase B — Modelo de permisos (propuesta)

**No está implementado.** Esto es para que lo apruebes o lo corrijas antes de
programar nada.

---

## 1. Los roles

Hoy el enum tiene `SUPERADMIN · OWNER · ADMIN · ALMACENERO · VENDEDOR`. Pediste
*dueño, administrador, cajero, almacenero*. El mapeo:

| Tú dijiste | Enum | Cambio |
|---|---|---|
| Dueño | `OWNER` | — |
| Administrador | `ADMIN` | — |
| Cajero | `VENDEDOR` | ⚠️ **renombrar a `CAJERO`** |
| Almacenero | `ALMACENERO` | — |
| (plataforma) | `SUPERADMIN` | — |
| Contador | `CONTADOR` | ⚠️ **añadir** (lo pedía el pliego original) |

**Sobre el renombrado.** `ALTER TYPE "Role" RENAME VALUE 'VENDEDOR' TO 'CAJERO'`
es instantáneo y no destructivo en Postgres. Toca ~20 referencias en código y
pruebas. Lo propongo porque «vendedor» y «cajero» conviviendo en la cabeza del
dueño es una fuente de errores al asignar permisos. **Si prefieres no tocarlo,
dilo y lo dejo como está** — es cosmético, no funcional.

---

## 2. La decisión de diseño que necesito que apruebes

Hoy los permisos son una **escalera**: `ROLE_RANK` da un número a cada rol y
`hasRole(actual, minimo)` compara. Simple y funciona, pero tiene un límite
duro: **no se puede dar un permiso a un rol bajo sin dárselo también a todos
los de arriba**, ni quitárselo a uno de arriba.

Y tu pliego pide justo eso: *«permisos granulares (vender, anular, descuentos,
ajustar stock, ver costos, emitir NC, ver reportes)»*. Dos ejemplos que la
escalera no sabe expresar:

- El **contador** debe ver reportes y comprobantes, pero **no** vender ni tocar
  stock. No está «por encima» ni «por debajo» del cajero: está al lado.
- **Ver costos** es información sensible (margen del negocio). Un cajero no
  debería verla, pero sí vender. Con la escalera, cualquier permiso que tenga
  el cajero lo hereda el almacenero.

### Propuesta: permisos nombrados, con el rol como preajuste

```
Permiso         → lo que habilita
─────────────────────────────────────────────────────────────────
venta.crear       cobrar en el POS
venta.anular      anular una venta ya cobrada
venta.descuento   aplicar descuento de línea
venta.sin_stock   forzar venta con stock negativo
cotizacion.crear  guardar y convertir cotizaciones
stock.mover       entradas y salidas
stock.ajustar     conteo físico (sobrescribe el saldo)
stock.transferir  pedir, despachar y recibir entre sucursales
producto.crear    alta de productos y catálogo
producto.costo    VER precios de costo y margen
comprobante.emitir   boleta y factura
comprobante.anular   nota de crédito  (⚠️ no implementada aún)
caja.abrir        abrir y cerrar turno
caja.arquear      ver descuadres de turnos ajenos
cliente.gestionar alta y edición de clientes
reporte.ver       reportes de venta y caja
usuario.gestionar CRUD de usuarios e invitaciones
sucursal.gestionar  alta y edición de sucursales
serie.configurar  correlativo inicial  (⚠️ irreversible)
plan.gestionar    contratar y pagar
```

### Matriz por rol (el preajuste)

| Permiso | OWNER | ADMIN | CAJERO | ALMACENERO | CONTADOR |
|---|:-:|:-:|:-:|:-:|:-:|
| `venta.crear` | ✅ | ✅ | ✅ | — | — |
| `venta.anular` | ✅ | ✅ | — | — | — |
| `venta.descuento` | ✅ | ✅ | ⚙️ | — | — |
| `venta.sin_stock` | ✅ | ✅ | ⚙️ | — | — |
| `cotizacion.crear` | ✅ | ✅ | ✅ | — | — |
| `stock.mover` | ✅ | ✅ | — | ✅ | — |
| `stock.ajustar` | ✅ | ✅ | — | ⚙️ | — |
| `stock.transferir` | ✅ | ✅ | — | ✅ | — |
| `producto.crear` | ✅ | ✅ | — | ✅ | — |
| **`producto.costo`** | ✅ | ✅ | ❌ | ❌ | ✅ |
| `comprobante.emitir` | ✅ | ✅ | ✅ | — | — |
| `comprobante.anular` | ✅ | ✅ | — | — | — |
| `caja.abrir` | ✅ | ✅ | ✅ | — | — |
| `caja.arquear` | ✅ | ✅ | — | — | ✅ |
| `cliente.gestionar` | ✅ | ✅ | ✅ | — | — |
| `reporte.ver` | ✅ | ✅ | — | ⚙️ | ✅ |
| `usuario.gestionar` | ✅ | ✅ | — | — | — |
| `sucursal.gestionar` | ✅ | ✅ | — | — | — |
| **`serie.configurar`** | ✅ | ✅ | — | — | — |
| `plan.gestionar` | ✅ | ❌ | — | — | — |

✅ por defecto · — no · ⚙️ **activable por el dueño, apagado de fábrica**
❌ explícitamente denegado

**Lo que cambia respecto de hoy:** `producto.costo` deja de depender del rango.
Hoy un almacenero ve los costos porque está «por encima» del cajero; con esto,
ninguno de los dos los ve, y el contador sí.

**Lo que NO cambia:** `hasRole` sigue existiendo para lo que de verdad es
jerárquico, y la matriz se evalúa en el servidor. Un permiso en la UI es
pintura; lo que manda es la comprobación del servicio, igual que ahora.

---

## 3. Roles **por sucursal**

Pediste roles por sucursal. Hoy `User.role` es uno solo para todo el negocio y
`UserBranch` solo dice a qué sucursales entra.

**Propuesta:** el rol pasa a `UserBranch`, con el de `User` como respaldo.

```
UserBranch { tenantId, userId, branchId, role? }
```

- `role` nulo → se usa `User.role` (lo de hoy; nada se rompe al migrar).
- `role` presente → manda para esa sucursal.

Así el encargado de SJL puede ser `ADMIN` allí y `CAJERO` en la matriz, que es
un caso real en cadenas pequeñas.

⚠️ **El coste honesto:** `TenantContext.role` deja de ser «el rol del usuario»
y pasa a ser «su rol EN LA SUCURSAL ACTIVA». Hay que repasar los ~29 sitios que
llaman a `hasRole(ctx.role, …)` y confirmar que todos quieren eso. Creo que sí
—todas son operaciones de una sucursal concreta— salvo `usuario.gestionar`,
`sucursal.gestionar` y `plan.gestionar`, que son del negocio entero y deberían
mirar el rol de `User`.

**Si prefieres no complicarlo**, lo dejo como hoy (un rol por usuario) y las
sucursales solo controlan el acceso. Dímelo: es la decisión con más
consecuencias de esta fase.

---

## 4. PIN de cajero

Para el relevo de turno sin cerrar sesión.

| | |
|---|---|
| Qué es | 4-6 dígitos por usuario, `User.pinHash` con bcrypt |
| Para qué | Cambiar de cajero en el mismo dispositivo, sin teclear correo y contraseña |
| Alcance | **Solo cambia quién opera, NUNCA eleva permisos** |

🔴 **La regla que lo hace defendible:** el PIN sirve para *identificar* en un
dispositivo ya autenticado, no para *autenticar* desde cero. Concretamente:

- Solo funciona si ya hay una sesión válida del negocio en ese dispositivo.
- Solo entre usuarios de **la sucursal activa**.
- **No** da acceso a `/sucursales`, `/mi-plan` ni a nada de `usuario.gestionar`:
  para eso hay que entrar con contraseña.
- Límite de intentos por dispositivo, igual que el login.

Sin esas condiciones, un PIN de 4 dígitos sería una contraseña de 10 000
combinaciones para entrar a un sistema con dinero dentro.

---

## 5. Sesiones por dispositivo

Pediste cierre remoto. Hoy la sesión es un JWT sin registro, así que **no se
puede cerrar una concreta**: solo cambiar la contraseña, que cierra todas.

**Propuesta:** tabla `DeviceSession` + un `sid` en el JWT.

```
DeviceSession { id, userId, tenantId, label, userAgent, ip,
                lastSeenAt, createdAt, revokedAt? }
```

- Al entrar se crea la fila y su id va en el JWT como `sid`.
- Revocar = poner `revokedAt`. La sesión muere en la navegación siguiente.
- `lastSeenAt` se refresca para «cerrar por inactividad».

⚠️ **El coste, y hay que decirlo claro:** comprobar `revokedAt` es **una
consulta más por petición**. Acabamos de quitar la del proxy justamente para
ahorrarla. Mitigaciones posibles, de menos a más:

1. Comprobarlo **solo en el layout** (ya consulta la sesión; se añade al
   `select` existente, coste ~0). Una sesión revocada muere en la siguiente
   navegación, no en el siguiente clic. **Es lo que recomiendo.**
2. Comprobarlo también en cada Server Action que escriba (una consulta extra
   solo al escribir, no al navegar).
3. Caché en Vercel KV. Más piezas; lo dejaría para cuando haga falta.

---

## 6. Orden propuesto

1. `CONTADOR` al enum + renombrar `VENDEDOR` → `CAJERO` (migración trivial).
2. Permisos nombrados + matriz + `can(ctx, permiso)` **con prueba estructural**
   que falle si un servicio comprueba el rol a mano en vez de pedir el permiso.
3. CRUD de usuarios + invitaciones por token con caducidad.
4. Rol por sucursal — **solo si lo apruebas** (punto 3).
5. Sesiones por dispositivo con cierre remoto.
6. PIN de cajero.
7. **MFA al final**, como pediste.

---

## Lo que necesito de ti

1. **¿Permisos nombrados o seguimos con la escalera de roles?** (§2)
2. **¿Rol por sucursal, o un rol por usuario?** (§3) — la de más consecuencias.
3. **¿Renombro `VENDEDOR` → `CAJERO`?** (§1)
4. **¿Te vale que el cierre remoto surta efecto en la navegación siguiente** en
   vez de instantáneamente, para no reintroducir una consulta por petición? (§5)
