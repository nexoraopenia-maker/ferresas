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
- `20261118100000_kardex_costo` (F6.4a, expand): tipo `MovementCostOrigin` (`EXACTO`, `RECONSTRUIDO`, `SIN_DATO`) y columnas `unitCostApplied`, `costAfter` (nulas) y `costOrigin` (`NOT NULL DEFAULT 'SIN_DATO'`, constante: no reescribe la tabla) en `stock_movements`; dos CHECK (costos nunca negativos; un dato conocido trae el promedio y `SIN_DATO` no trae cifras). Las filas existentes quedan `SIN_DATO` hasta correr `scripts/rellenar-costo-kardex.ts`. `down.sql` ensayado: sin deriva en ambos sentidos y reaplicable.
- `20261119100000_toma_inventario` (F6.5a, expand): tipos `InventoryCountStatus/Scope/Mode/ItemStatus` y tablas `inventory_counts`, `inventory_count_items`, `inventory_count_entries` con sus claves compuestas, el índice único parcial de un conteo abierto por almacén, los de línea sin/con variante y los CHECK de coherencia (con `IS NOT NULL` explícito: un `NULL` aprueba un CHECK). `down.sql` ensayado sin deriva en ambos sentidos.
- `20261120100000_toma_inventario_revision` (F6.5b, expand): columnas nulas en `inventory_count_items` (sistema al contar, diferencia, movimientos posteriores, costo del ajuste, movimiento resultante, quién revisó y nota), el índice único `stock_movements(tenantId, id)` (para la clave compuesta al movimiento resultante; ⚠️ construirlo escanea `stock_movements` una vez) y siete CHECK. Sin tocar filas existentes. `down.sql` ensayado sin deriva en ambos sentidos y reaplicable.
- `20261121100000_reposicion_maximos` (F6.6a, expand): columnas nulas `maxStock` en `stocks` y `product_variants` (nivel objetivo por almacén y por variante; hereda del producto cuando es NULL) y dos CHECK con `IS NOT NULL` explícito (máximo ≥ 0 y ≥ el mínimo de la misma fila). Sin tocar filas existentes ni reescribir tablas. `down.sql` ensayado sin deriva en ambos sentidos y reaplicable.
- `20261122100000_listas_precio` (F6.7a, expand): tipo `PriceSource` (`BASE`, `LISTA`, `VOLUMEN`); tablas `price_lists`, `price_list_entries` y `price_tiers` (el tramo de una lista cuelga de la entrada de esa lista por clave compuesta, con borrado en cascada); columnas nulas `customers.priceListId`, `sales.priceListId`, `quotes.priceListId`, `sale_items.priceSource` y `sale_items.tierMinQuantity`; CHECK con `IS NOT NULL` explícito (nombre y código de lista, precios y cantidades de tramo, y que el tramo aplicado de una línea vaya si y solo si la fuente es `VOLUMEN`); dos índices únicos PARCIALES que Prisma no expresa (nombre de lista sin distinguir mayúsculas entre las no borradas, y tramos de la lista Base con `priceListId` NULL) y un índice parcial de apoyo en `customers`. Sin tocar filas existentes. `down.sql` ensayado sin deriva en ambos sentidos y reaplicable (⚠️ borra listas, precios, tramos y la lista por defecto de los clientes).
- `20261123100000_cajas_registradoras` (F6.8a, **paso 1 de 2: expandir**): tabla `cash_registers` (la caja, con baja lógica), columnas nulas `cash_sessions.registerId` (clave compuesta a la caja) y `closingBreakdown` (JSONB, la foto del desglose del cierre), y el **relleno**: una «Caja principal» por sucursal (id determinista) y TODOS los turnos —cerrados y abiertos— asignados a ella (idempotente, sin tocar `updatedAt`). Retira el índice `cash_sessions_una_abierta_por_sucursal` y crea tres parciales: `…_por_caja`, `…_por_persona` y `…_sin_caja` (uno por sucursal para los turnos sin caja, que puede abrir la versión anterior del código en la ventana de despliegue), más `cash_registers_name_uniq` (nombre único sin distinguir mayúsculas entre las vivas de la sucursal) y dos CHECK. ⚠️ **ANTES de aplicar:** correr `scripts/verificar-turnos-abiertos.ts` (el índice por persona falla si alguien tiene hoy dos turnos abiertos y una migración fallida deja la base en P3009). El paso 2 (F6.8d, push aparte): `registerId` NOT NULL tras `scripts/verificar-turnos-sin-caja.ts` en cero. `down.sql` ensayado sin deriva en ambos sentidos y reaplicable (⚠️ borra las cajas y las fotos del desglose; falla si ya hay dos turnos abiertos en una sucursal).
- `20261124100000_cajas_obligatorias` (F6.8d, **paso 2 de 2: contraer**): `cash_sessions.registerId` pasa a NOT NULL; se retira el índice de transición `cash_sessions_una_abierta_sin_caja` y `cash_sessions_una_abierta_por_caja` pierde la condición `IS NOT NULL` (ya no puede ser falsa); se elimina la columna `tenants.cashRequired` (el turno propio es obligatorio siempre). ⚠️ **Destructiva**: `cashRequired` se pierde (el `down.sql` la recrea apagada) y NOT NULL falla si queda una fila sin caja. Antes de aplicar se corrió `scripts/verificar-turnos-sin-caja.ts` en producción (cero); por si aun así quedara una, la migración repite el relleno idempotente del paso 1 (cajas faltantes y turnos sin caja → caja viva más antigua de su sucursal) ANTES de exigir NOT NULL, así no puede dejar la base marcada como fallida (P3009) por ese motivo. Ensayada con un turno sin caja sembrado (queda asignado), sin deriva con Prisma en ambos sentidos y reaplicable. Con ella se retiró el script `verificar-turnos-sin-caja`.
- `20261125100000_sunat_credenciales` (S2, expand): tipo `SunatAmbiente` (`BETA`, `PRODUCCION`) y tabla `sunat_credentials` (una fila por negocio: `.pfx`, su clave y la clave SOL CIFRADOS, usuario SOL secundario, ambiente —por defecto `BETA`—, metadatos del certificado y última prueba de conexión) con cuatro CHECK (los secretos empiezan por `v1.` o `v2.`, usuario SOL alfanumérico de 3 a 30, vigencia coherente, prueba coherente). Sin tocar filas existentes. `down.sql` ensayado sin deriva en ambos sentidos y reaplicable.
- `20261126100000_archivos_fiscales` (S3, expand): tipo `TaxFileKind` (`XML_FIRMADO`, `CDR`) y tabla `tax_document_files` (el XML firmado y el CDR de cada comprobante, comprimidos con gzip, con el SHA-256 y el tamaño del contenido sin comprimir) con clave compuesta al comprobante (borrado en cascada solo con el comprobante o el negocio), índice único por comprobante y tipo, dos CHECK (hash de 64 hex; tamaño entre 1 B y 5 MB) y un **disparador que impide modificar** un archivo ya guardado. Sin tocar filas existentes. `down.sql` ensayado sin deriva en ambos sentidos y reaplicable (⚠️ la reversa borra los archivos guardados).
