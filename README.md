# FerreSaaS

Inventario y punto de venta multi-tenant para ferreterías peruanas. Varias
sucursales, comprobantes con serie por establecimiento, arqueo de caja,
transferencias entre locales e impresión en papel térmico de 80 mm.

---

## Puesta en marcha en local

Requisitos: Node 20+, una base PostgreSQL (Neon va bien).

```bash
# 1. Dependencias (el postinstall ejecuta `prisma generate`)
npm install

# 2. Variables de entorno
cp .env.example .env.local
#    Edita .env.local — está documentado campo por campo.
#    Mínimo para arrancar: DATABASE_URL, DIRECT_URL, AUTH_SECRET, APP_URL.
#    Genera el secreto con:  openssl rand -base64 32

# 3. Esquema y datos de ejemplo
npm run db:deploy       # aplica las migraciones (no interactivo)
npm run db:seed         # planes + superadmin de desarrollo

# 4. Arranca
npm run dev             # http://localhost:3000
```

> `.env.local` manda sobre `.env`. La URL de **producción** no debe estar en
> ningún fichero local: vive solo en las variables de entorno de Vercel.

---

## Comandos

| Comando | Qué hace |
|---|---|
| `npm run dev` | Servidor de desarrollo |
| `npm run build` | Build de producción (en Vercel aplica migraciones antes) |
| `npm test` | Suite completa. **Exige `ALLOW_DESTRUCTIVE_TESTS=true`** |
| `npm run db:deploy` | `prisma migrate deploy` — aplica lo pendiente, sin preguntar |
| `npm run db:migrate` | `prisma migrate dev` — flujo interactivo de desarrollo. **Necesita TTY** |
| `npm run db:new-migration` | Crea una migración sin aplicarla, para revisar el SQL a mano |
| `npm run db:seed` | Planes y superadmin de desarrollo |
| `npm run test:branches` | Solo sucursales, caja y transferencias |
| `npm run test:proxy` | Solo el proxy y las pruebas **estructurales por AST** |
| `npm run test:print` | Solo impresión térmica |
| `npx tsc --noEmit` | Comprobación de tipos |

### Pruebas estructurales

Además de las de comportamiento, hay pruebas que analizan el **código** con
AST (`tests/ast.ts`, con `ts-morph`). La principal falla —**nombrando el
archivo**— si alguna página, layout, Server Action o ruta de API se salta la
verificación de sesión contra la base.

Son por AST y no por búsqueda de texto porque la versión anterior dio tres
falsos positivos: la cadena buscada estaba en un comentario que explicaba por
qué el código NO hacía eso. Detalle en `docs/ARCHITECTURE.md` §12.

### Las pruebas escriben de verdad

La suite crea y borra datos en la base que apunte tu entorno. Por eso
`tests/guard.ts` **se niega a arrancar** salvo que el entorno declare
explícitamente que es desechable:

```bash
ALLOW_DESTRUCTIVE_TESTS=true
```

Producción nunca llevará esa variable, así que olvidarse de cambiar la URL ya
no destruye nada: simplemente los tests no arrancan. Esta guardia existe
porque, antes de tenerla, dos ejecuciones de `npm test` dejaron tenants de
prueba en la base de producción.

Apunta tu `.env.local` a una **rama de staging** de Neon. Ver `STAGING.md`.

---

## Reglas no negociables

1. **Prohibido `prisma db push` en producción.** Solo `migrate deploy` con
   migraciones revisadas.
2. **Nunca `DELETE`** de clientes, ventas, productos ni sucursales: borrado
   lógico con `deletedAt`.
3. **Toda Server Action valida permisos en el servicio**, no en la UI: una
   Server Action es un endpoint HTTP y cualquiera puede invocarla a mano.
4. **Ningún secreto en el código.** Todo en `.env` / `.env.local`.
5. **Fechas con la zona del negocio.** El servidor corre en UTC; usar
   `formatearFechaLocal`.

---

## Qué hay construido

| Módulo | Estado |
|---|---|
| Multi-tenancy con FK compuestas | ✅ |
| Autenticación, roles y bloqueo por impago | ✅ |
| Inventario con escáner de códigos | ✅ |
| Importación masiva de catálogo (CSV) | ✅ |
| Punto de venta, cotizaciones, venta forzada | ✅ |
| Comprobantes: serie y correlativo sin huecos | ✅ |
| Impresión térmica 80 mm (ticket, boleta, factura, cotización) | ✅ |
| Sucursales con serie propia por establecimiento | ✅ |
| Turno de caja con arqueo | ✅ |
| Transferencias entre sucursales en dos pasos | ✅ |
| Torre de control (Super Admin) con impersonation auditada | ✅ |
| Cobro con Stripe y MercadoPago | ✅ |
| Correlativo inicial por serie, para quien ya facturaba | ✅ |
| Interfaz agnóstica de proveedor de facturación + adaptador simulado | ✅ |
| Cargador de ubigeo del INEI con validación fail-closed | ✅ (tabla vacía: falta el archivo oficial) |

### Lo que falta

| Pendiente | Nota |
|---|---|
| Envío real a SUNAT | Decidido: **vía PSE/OSE**. La interfaz y el mock ya están; falta el proveedor. Ver `docs/SUNAT-OPCIONES.md` |
| QR en el comprobante impreso | Depende de la firma: sin `hash` un QR no valida |
| Notas de crédito | Es la única forma de anular un comprobante en Perú |
| Gestión de usuarios (invitaciones, PIN, MFA, sesiones por dispositivo) | Fase B. Modelo propuesto en `docs/PERMISOS-PROPUESTA.md`, **pendiente de aprobación** |
| PWA instalable y modo offline del POS | Pospuesto a propósito |
| Trazabilidad de lotes y vencimientos (FEFO, GS1-128) | Fuera de este ciclo |
| Selector de ubigeo en cascada | El cargador está listo; falta el archivo oficial del INEI |
| Arranque en frío de Neon (~70-700 ms) | Tres opciones con costos en `docs/NEON-ARRANQUE-FRIO.md`, **pendiente de decisión** |
| Limitador de peticiones compartido | Hoy es en memoria, por instancia. `checkRateLimit` ya es `async` para poder usar Vercel KV |
| Notificaciones por correo | Nada implementado |

---

## Rendimiento del panel

Medido **dentro de producción** (`/api/diagnostics/perf`), no desde un
portátil: la latencia a Neon cambia de 18 ms a 605 ms según desde dónde se
mida, y eso domina cualquier conclusión local.

| | antes | después |
|---|---|---|
| Consulta de sesión | 45-48 ms (3,2 idas y vueltas) | **4-17 ms** (1,0) |
| Resoluciones de sesión por navegación | 3 | **1** |
| Proxy (São Paulo → base en Ohio) | ~120-140 ms | **1-2 ms**, sin consulta |
| Trabajo de base por navegación | ~143 ms | **~29 ms** |
| Región de las funciones | `iad1` | `cle1` = `us-east-2`, la de Neon |
| Respuesta visual al clic | esperaba al servidor | **inmediata** (esqueleto + menú optimista) |

Para medirlo tú desde Lima, con tu sesión: `docs/MEDIR-DESDE-LIMA.md`.

**Lo que queda:** el arranque en frío de Neon (~70-700 ms en la primera
navegación tras una pausa). Son tres opciones con costos en
`docs/NEON-ARRANQUE-FRIO.md`, pendientes de decisión.

## Documentación

| Documento | Contenido |
|---|---|
| `docs/ARCHITECTURE.md` | Por qué el sistema está construido así, y las trampas ya pisadas |
| `docs/COMPLIANCE.md` | Lo que depende de SUNAT/INEI, con ⚠️ en lo que se asume sin verificar |
| `docs/SUNAT-OPCIONES.md` | Los dos caminos para emitir de verdad (PSE/OSE o envío propio), con esfuerzo, riesgo y costo |
| `docs/ONBOARDING-FISCAL.md` | Qué pedirle a cada cliente para que pueda facturar |
| `docs/REGIONES.md` | Por qué las funciones corren en `cle1`, y cómo se le quitó la consulta al proxy |
| `docs/PERMISOS-PROPUESTA.md` | Modelo de permisos de la fase B, **pendiente de aprobación** |
| `docs/NEON-ARRANQUE-FRIO.md` | Las tres opciones contra el scale-to-zero, con costos |
| `docs/MEDIR-DESDE-LIMA.md` | Cómo medir tú el TTFB real, con tu sesión y tu red |
| `docs/REPORTE-REDONDEO.txt` | Qué importes cambiarían al endurecer el redondeo a céntimos |
| `STAGING.md` | Cómo levantar un entorno de staging aislado |
| `.env.example` | Todas las variables, documentadas una por una |
