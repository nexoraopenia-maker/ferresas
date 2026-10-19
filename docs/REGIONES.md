# Región de las funciones

## El problema

Medido en producción con `/api/diagnostics/perf`:

```
región Vercel : iad1   (us-east-1, Washington D.C.)
host Neon     : ep-wandering-bread-ayy7p37j-pooler.c-5.us-east-2.aws.neon.tech
ping caliente : 11-16 ms
```

Las funciones corrían en **us-east-1** y la base está en **us-east-2**. Esos
11-16 ms son el trayecto entre ambas, y **se pagan una vez por consulta**. Una
pantalla del panel hace entre 4 y 6, así que son 50-90 ms de puro trayecto
antes de contar el trabajo real.

## El cambio

`vercel.json` fija `"regions": ["cle1"]`. Según la tabla de regiones de
Vercel, **`cle1` es `us-east-2` (Cleveland)**: la misma región de AWS donde
está el cómputo de Neon. El trayecto baja de ~14 ms a un dígito.

## Por qué esto NO aleja al usuario de Lima

Es la duda razonable: si la función se mueve a Cleveland, ¿no queda más lejos
de Lima que Washington?

En la práctica no, por cómo está montada la red de Vercel. Su documentación lo
describe así: los **PoP** (126 puntos de presencia) terminan el TCP y el TLS
cerca del usuario y encaminan la petición *por red privada* hasta la región de
cómputo más cercana, con latencia de un dígito. El usuario en Lima sigue
hablando con el PoP que le toca; lo que cambia es el último tramo, interno.

El canje, además, es asimétrico y favorable:

| | antes (iad1) | después (cle1) |
|---|---|---|
| Trayecto a la base, **por consulta** | ~14 ms | un dígito |
| Consultas por pantalla | 4-6 | 4-6 |
| Coste total del trayecto | **50-90 ms** | **~5-20 ms** |
| Trayecto del usuario | 1 vez | 1 vez, ~igual |

La distancia a la base se multiplica por el número de consultas; la del
usuario, no.

## Riesgo

Bajo. Si la región no estuviera disponible para el plan, **el build falla y
Vercel NO promueve el despliegue**: producción sigue sirviendo la versión
anterior. No hay ventana de caída.

`iad1` sigue siendo el P0 de failover de Vercel, y `cle1` su P1, así que
elegir `cle1` no sale del par de regiones mejor conectadas entre sí.

## Fuente

- [Vercel — Global network and regions](https://vercel.com/docs/edge-network/regions):
  tabla de regiones (`cle1` → `us-east-2`), el papel de los PoP y la
  recomendación explícita de ejecutar las funciones en la misma región que la
  base de datos.

---

## ⚠️ HALLAZGO: el proxy NO respeta `regions`

Medido sobre el **mismo despliegue**, con la región que cada capa reporta de
sí misma:

```
proxy   (cabecera Server-Timing) : gru1   ← São Paulo
función (Route Handler)          : cle1   ← Cleveland, us-east-2
```

Tres muestras seguidas: `gru1` las tres veces. No es variación.

**Qué significa.** `vercel.json → regions` fija dónde corren las *Vercel
Functions*, pero el proxy de Next 16 se despliega **distribuido** y se ejecuta
en la región más cercana al usuario. Para una petición desde Perú, eso es
`gru1`.

**Por qué importa.** El proxy **consulta la base** en cada navegación
(`getRouteSession`, para resolver rol y estado de suscripción). Así que esa
consulta —la más repetida de toda la aplicación— sale de São Paulo hacia Ohio:

| Capa | Dónde corre | Distancia a Neon (us-east-2) |
|---|---|---|
| Proxy | `gru1` São Paulo | ⚠️ **~120-140 ms** |
| Páginas y handlers | `cle1` Cleveland | **2-6 ms** medidos |

Mover las funciones a `cle1` arregló las páginas (4,3x más rápidas, medido) y
**no tocó el gasto del proxy**, que ahora es el mayor de todos.

## ✅ RESUELTO — el proxy ya no consulta la base

Medido en producción tras el cambio, cinco muestras:

```
#1  jwt;dur=2, post_jwt;dur=0, proxy_total;dur=2, region;desc="gru1"
#2  jwt;dur=1, post_jwt;dur=0, proxy_total;dur=1, region;desc="gru1"
#3  jwt;dur=1, post_jwt;dur=0, proxy_total;dur=1, region;desc="gru1"
```

**El proxy sigue corriendo en `gru1`** —eso no se puede cambiar— pero ya no
sale de ahí hacia la base: `proxy_total` pasó de **~120-140 ms a 1-2 ms**.

### Por qué esos 1-2 ms son PRUEBA y no declaración

Esta distinción importa, porque la primera versión de la instrumentación no
probaba nada: ponía `sesion_bd;dur=0` **escrito a mano**. Un literal nunca
cambia, así que si alguien reintrodujera la consulta, el supuesto detector
habría seguido diciendo 0.

Ahora `post_jwt` **mide** el tramo donde vivía la consulta. Y desde `gru1` una
ida y vuelta a `us-east-2` cuesta ~120 ms: un tramo de un dígito es
**físicamente incompatible** con una consulta a la base. Eso, más la prueba
estructural que comprueba que `src/proxy.ts` no importa `prisma`, es lo que
sostiene la afirmación.

## Cómo se hizo



Quitarle la consulta a la base al proxy, y dejarle solo lo que puede decidir
con el JWT: ¿hay token o no hay? Si no hay, al login. Las decisiones que SÍ
necesitan la base —estado de suscripción, rol, el 404 de `/superadmin`— se
resolverían en el layout y las páginas, que corren en `cle1` pegadas a la base
y ya resuelven la sesión una vez (memoizada).

Es defendible porque el propio `route-access.ts` lo dice en su cabecera:

> ⚠️ ESTO NO ES LA FRONTERA DE SEGURIDAD. Es UX: evita que alguien vea una
> pantalla que no le sirve. El enforcement real vive en getTenantPrisma().

Mover una comprobación de UX de una capa a otra no debilita nada; el
enforcement no se movió.

**Dónde quedó cada comprobación:**

| Qué | Dónde se comprueba ahora | Región |
|---|---|---|
| ¿Hay sesión? ¿Qué rol? | proxy, con el JWT firmado | `gru1`, 1-2 ms |
| ¿Modo soporte vigente? | proxy, con un token HMAC con `exp` dentro | `gru1`, 0 ms |
| Usuario desactivado o borrado | `(dashboard)/layout.tsx` → `guardDashboard` | `cle1`, pegado a la base |
| Sesión revocada por cambio de contraseña | ídem | `cle1` |
| Tenant suspendido | ídem | `cle1` |
| Rol REAL para `/superadmin` | `(superadmin)/layout.tsx` | `cle1` |
| Rol y plan en cada operación | `requireTenantContext()`, memoizado | `cle1` |
| Toda escritura | `getTenantPrisma()` | `cle1` |

**Ahorro medido: ~120-140 ms por navegación.**

### La red que sustituye a la del proxy

Antes, una página que se olvidara de comprobar quedaba cubierta por el 307 del
proxy. Ahora ese olvido sería un agujero real, así que
`tests/proxy-sin-bd.ts` incluye una prueba **estructural**: recorre páginas,
layouts, Server Actions y rutas de API y **falla nombrando el archivo** que no
verifique contra la base. Las excepciones son una lista explícita con su
motivo.

Encontró una de verdad al escribirla: `(dashboard)/inventario/page.tsx` no
verificaba nada. Funcionaba porque el layout lo cubre, pero mover el archivo
lo habría abierto sin que nada avisara.

### El detalle de la transición

El rol viaja en el JWT desde este cambio, así que **las sesiones que ya
estaban abiertas** el día del despliegue tienen un token **sin rol**.

La primera versión asumía el rol más bajo cuando faltaba. Consecuencia: todas
esas sesiones —incluida la del superadmin— habrían sido desviadas y acabado en
el login de una vez. Funcionalmente correcto, operativamente molesto y sin
ninguna necesidad.

Ahora un rol ausente significa **«no se sabe»** y la decisión se delega en el
render, que sí lee la base:

| Ruta | token sin rol | token con rol ≠ SUPERADMIN |
|---|---|---|
| `/pos` | pasa; `guardDashboard` decide | pasa |
| `/superadmin` | pasa; el layout responde `notFound()` | **404 en el proxy** |

**No se pierde seguridad.** Para `/superadmin`, el layout lee el rol REAL y
responde `notFound()` — exactamente la misma respuesta que daría el proxy, así
que la indistinguibilidad que protege esa ruta se conserva. Lo único que
cambia es quién la emite.

La ventana se cierra sola: en cuanto cada usuario vuelve a entrar, su token ya
trae el rol.
