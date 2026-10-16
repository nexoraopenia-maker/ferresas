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
| `npm run test:print` | Solo impresión térmica |
| `npx tsc --noEmit` | Comprobación de tipos |

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

### Lo que falta

| Pendiente | Nota |
|---|---|
| Envío real a SUNAT (XML UBL 2.1, firma XAdES, OSE) | Lo más importante que falta. Ver `docs/COMPLIANCE.md` |
| QR en el comprobante impreso | Depende de la firma: sin `hash` un QR no valida |
| Notas de crédito | Es la única forma de anular un comprobante en Perú |
| Gestión de usuarios (invitaciones, PIN, MFA, sesiones por dispositivo) | Los roles existen; falta el CRUD |
| PWA instalable y modo offline del POS | Pospuesto a propósito |
| Trazabilidad de lotes y vencimientos (FEFO, GS1-128) | Fuera de este ciclo |
| Limitador de peticiones compartido | Hoy es en memoria, por instancia. `checkRateLimit` ya es `async` para poder usar Vercel KV |
| Notificaciones por correo | Nada implementado |

---

## Documentación

| Documento | Contenido |
|---|---|
| `docs/ARCHITECTURE.md` | Por qué el sistema está construido así, y las trampas ya pisadas |
| `docs/COMPLIANCE.md` | Lo que depende de SUNAT/INEI, con ⚠️ en lo que se asume sin verificar |
| `STAGING.md` | Cómo levantar un entorno de staging aislado |
| `.env.example` | Todas las variables, documentadas una por una |
