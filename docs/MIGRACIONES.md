# Convención de migraciones

Las migraciones de Prisma solo avanzan. Para poder desplegar sin caídas y deshacer con
criterio, se sigue **expand / contract**:

1. **Expand** — se AÑADE lo nuevo sin romper lo viejo: columnas nulas o con valor por
   defecto, tablas e índices nuevos. El código viejo y el nuevo conviven. Estas
   migraciones **no necesitan `down.sql`**: deshacerlas es simplemente no usar lo añadido.
2. **Migrate** — si hay que mover datos, se hace en una migración de DATOS aparte.
3. **Contract** — se QUITA lo viejo (columna, tabla, restricción) solo cuando ningún
   código la usa ya. Es la parte destructiva.

## `down.sql`

Solo para migraciones **destructivas** (contract) o **de datos**: junto a `migration.sql`
va un `down.sql` que las deshace en lo que sea posible (y dice por escrito lo que NO se
puede recuperar, por ejemplo una columna borrada con datos). Prisma no lo ejecuta: es la
receta para revertir a mano, y debe haberse probado en un esquema temporal.

## Cómo se prepara una migración

1. Cambiar `prisma/schema.prisma`.
2. Generar el SQL con `prisma migrate diff --from-schema <antes> --to-schema prisma/schema.prisma --script`
   (nunca escrito a mano: una migración a mano con el nombre de tabla equivocado dejó
   producción en P3009).
3. Repetir TODAS las migraciones en un esquema temporal de staging y comprobar que no
   queda deriva (`No difference detected`).
4. Aplicar a staging con `prisma migrate deploy`. Producción lo aplica el build de Vercel **si Vercel ejecuta el script `build` del repositorio y el despliegue es de Production**. No se da por hecho: el build imprime `[build] …` con lo que decidió, y `/api/diagnostics` avisa de las migraciones sin aplicar. Si falta una, se aplica a mano:
   `I_UNDERSTAND_THIS_IS_PRODUCTION=true npx prisma migrate deploy` con `DIRECT_URL` (sin `-pooler`), `DATABASE_URL` y `PROD_DB_FINGERPRINT` de producción **escritos en la propia línea de comandos** (el shell gana sobre `.env.local`, que es staging). Primero `migrate status`. Ocurrió con la Fase 4 (2026-10-27): ver `docs/DESPLIEGUE-FASE4.md`.

## Nombres y orden

El nombre de cada carpeta empieza por una marca de tiempo, y Prisma ordena por ella. Se
comprobó en un esquema temporal (2026-10-22) que `prisma migrate deploy` **aplica** una
migración con marca anterior aunque ya haya otras posteriores aplicadas: no falla. Aun así,
**no se retrocede**: el orden de las carpetas es el orden en que se aplican en una base
NUEVA, y debe coincidir con el de producción. Regla: la marca de una migración nueva es
mayor que la de todas las existentes (la hora real, o un minuto después de la última si la
hora real quedara por detrás). Las ya aplicadas en algún entorno no se renombran nunca.

## Ensayo de un `down.sql`

Un `down.sql` no vale hasta que se ha probado: se aplican todas las migraciones en un esquema
temporal, se ejecuta el `down.sql` y se comprueba con `prisma migrate diff` contra el esquema
anterior que no queda **ninguna** diferencia. (Hecho para `20261102120000_fiscal_modo_ensayo`.)

## Guardia de huella de producción

`prisma.config.ts` evalúa `scripts/huella-bd.ts` en **cada** comando de prisma que toca la base (`migrate`, `db`, `studio`), incluido el `.env` por defecto. La huella es `host/nombre_de_base` (sin `-pooler`, usuario ni clave) y se compara contra `PROD_DB_FINGERPRINT` y contra lo que diga `.env`.

- Sin `PROD_DB_FINGERPRINT`: se niega todo (no se puede comprobar). **Hay que definirla también en las variables de Vercel**, o el build de producción no migrará.
- Contra producción solo se permiten `migrate deploy` y `migrate status`, y solo en el build de producción de Vercel (`VERCEL_ENV=production`) o con `I_UNDERSTAND_THIS_IS_PRODUCTION=true` escrito en la línea de comandos.
- **`DATABASE_URL` y `DIRECT_URL` deben ser la MISMA base** (la directa es la pooled sin `-pooler`; misma huella). Si difieren, todo comando de Prisma que toca la base se NIEGA, en cualquier entorno y aunque haya permiso de producción: la app leería una base y las migraciones se aplicarían a otra. Ocurrió en Vercel (2026-10-27): `DATABASE_URL` a producción y `DIRECT_URL` a staging; el build migró STAGING y producción se quedó sin las tablas de la Fase 4. Ahora ese build falla de inmediato con un mensaje que nombra las dos bases.
- `--config` y las URL pasadas por opción (`--url`, `--from-url`, `--to-url`, `--shadow-database-url`) se evalúan o se prohíben: no hay forma de saltarse la guardia.
- **Lista blanca:** fuera del camino de producción, un comando solo corre si TODAS las URL de conexión tienen la huella de `STAGING_DB_FINGERPRINT` (obligatoria, distinta de la de producción). Una base desconocida se niega aunque no sea producción.
- La suite (`tests/guard.ts`) y `scripts/migrar-staging.sh` usan la misma comprobación.

## Registro de migraciones recientes

- `20261113100000_compras_documento` (F5.4, expand): añade a `purchases` las columnas nulas `docType`, `docSeries`, `docNumber`, `issueDate`, el tipo `PurchaseDocType`, un índice y dos CHECK («todo o nada» y formato). Sin cambios de datos. `down.sql` ensayado (sin deriva). Despliegue: el build de producción de Vercel la aplica con `migrate deploy`; el código anterior sigue funcionando (columnas nulas) durante la ventana de despliegue.
- `20261114100000_devoluciones_venta` (F6.1a, expand): tipos `SaleReturnKind` y `RefundMode`; tablas `sale_returns`, `sale_return_items`, `sale_return_refunds`; columnas con valor por defecto en `cash_sessions`; índice único `(tenantId, id)` en `sale_items`; índice parcial y CHECK (incluido `sales_anulada_devuelta_chk`, que falla si hay ventas ANULADA/DEVUELTA sin fecha o motivo). **Comprobación previa obligatoria:** `npx tsx scripts/verificar-ventas-anuladas.ts` con el entorno de producción (sale 0 = se puede migrar). `down.sql` ensayado (sin deriva).
- `20261115100000_devolucion_parcial` (F6.2a, expand): tipo `ReturnDestination`; columnas `returnedQuantity`/`returnedAmount` (con valor por defecto) en `sale_items`, `returnTotal` en `sale_returns` y `subtotal`/`taxAmount`/`taxRate`/`destination`/`mermaId` en `sale_return_items` (las NOT NULL sin valor por defecto en el modelo se añaden con 0, se **rellenan** desde las devoluciones de F6.1 y se les quita el valor por defecto); tabla `tax_document_items`; CHECK de tope por línea, importes y destino↔merma. Sin pérdida de datos. `down.sql` ensayado (sin deriva), y el rellenado ensayado con filas sintéticas de F6.1. El build de Vercel la aplica con `migrate deploy`.
- `20261116100000_movimientos_caja` (F6.3a, expand): tipos `CashMovementKind` y `CashMovementCategory`; tabla `cash_movements` con sus claves compuestas, índices y CHECK; columnas `manualInTotal` y `manualOutTotal` (valor por defecto 0) en `cash_sessions`. Sin cambios de datos: los turnos existentes no cambian. `down.sql` ensayado (sin deriva). El build de Vercel la aplica con `migrate deploy`.
- `20261117100000_movimientos_compensacion_enum` y `20261117110000_movimientos_compensacion` (F6.3b, expand): valor `COMPENSACION_ABONO` del enum de categorías (migración propia: Postgres no permite usar un valor nuevo en la misma transacción que lo crea); columna `cash_movements.method` (por defecto EFECTIVO), CHECK de categoría, de compensación y de medio, e índice único parcial «una compensación por abono». Sin cambios de datos. `down.sql` de ambas ensayados (sin deriva): el de la segunda borra las compensaciones; el de la primera recrea el tipo sin el valor.
