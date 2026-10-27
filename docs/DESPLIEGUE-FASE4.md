# Despliegue de la Fase 4 (compras, proveedores y cuentas por pagar) a producción

Quién hace qué: **el usuario** hace el backup, el `push` y el QA en producción; **Claude** no tiene acceso a producción, no hace `push` y no pide credenciales. Producción es `ep-wandering-bread…/neondb` (`.env`); staging es `ep-plain-king…` (`.env.local`).

## Qué se despliega
- **6 commits** sobre `main` (63b7ad7): e8c6ad9 (modelo), 35eb9e3 (permisos y proveedores), 7cdd994 (compras), a1c6584 (pagos, caja, informes, auditoría), 01503aa (pantallas de proveedores y compras), 0add9c1 (por pagar, voucher, panel, caja, «pagar al recibir»).
- **1 migración**: `20261112100000_compras_cuentas_por_pagar`. **Solo aditiva** (tipos, columnas con valor por defecto, 3 tablas nuevas, índices, llaves foráneas y `CHECK`); 0 `DROP`/`RENAME`/`DELETE`/`UPDATE`. Aplicada a staging y repetida en un esquema temporal sin deriva.
- **Sin variables de entorno nuevas** (verificado en el diff).
- **Sin permisos que migrar**: la matriz vive en código; dueño y administrador reciben `proveedores.gestionar`, `compras.registrar` y `proveedores.pagar` al desplegar. El almacenero solo recibe `compras.registrar` si el dueño se lo activa en «Equipo».

## Cómo se aplica la migración (importante)
El script `build` de Vercel hace **`prisma migrate deploy` (solo si `VERCEL_ENV=production`) ANTES de `next build`**. O sea: al hacer `push`, la migración corre primero y el código nuevo solo se publica si el build termina bien. No hay que aplicarla a mano. Requiere `PROD_DB_FINGERPRINT` (y `DATABASE_URL`/`DIRECT_URL`) en las variables de Vercel; sin la huella el build se niega.

## Antes del push (en este orden)
1. **Backup de producción**: crea una rama/restore point en Neon de `wandering-bread` y anota su nombre y hora.
2. **Estado de migraciones** (solo lectura): `I_UNDERSTAND_THIS_IS_PRODUCTION=true npx prisma migrate status` con el `.env` de producción. Debe decir que solo falta `20261112100000_compras_cuentas_por_pagar`. Si aparece otra pendiente o una fallida (P3009), **no sigas** y avísame.
3. **Comprobación de filas existentes** (solo lectura). Los nuevos `CHECK` se validan contra lo que ya haya; nada en `main` escribía compras, así que debería haber 0:
   ```sql
   SELECT (SELECT count(*) FROM purchases)      AS compras,
          (SELECT count(*) FROM purchase_items) AS lineas,
          (SELECT count(*) FROM suppliers WHERE "deletedAt" IS NOT NULL) AS proveedores_de_baja;
   ```
   Si `compras` o `lineas` no son 0, avísame antes de seguir (hay que revisar que cumplan los `CHECK`).
4. **Variables en Vercel**: `PROD_DB_FINGERPRINT=host/nombre` de producción presente.
5. **Fusión local**: `compras-proveedores` → `main` (la hago yo cuando lo autorices; es local, sin `push`). Después, `npm test` + `next build` sobre `main`.
6. **Ventana**: hazlo fuera de horas de venta; la migración es corta, pero Neon Free puede tardar en arrancar en frío (ver `docs/NEON-ARRANQUE-FRIO.md`).

## El push (lo haces tú)
`git push origin main` → mira el build en Vercel. Debe verse `1 migration found` / `Applying migration 20261112100000_compras_cuentas_por_pagar` y luego `Compiled successfully`. Si la migración falla, **el build falla y el código viejo sigue sirviendo**: no hay corte. En ese caso copia el error, no reintentes a ciegas (ver `migraciones-a-mano` y P3009).

## Después del despliegue
1. **Auditorías de solo lectura** (con el entorno de producción): `npx tsx scripts/auditar-compras.ts` y `npx tsx scripts/auditar-credito.ts`. Con negocios sin compras ni deuda deben salir **0 errores**.
2. **QA manual en producción** (con un negocio de prueba o el tuyo con montos pequeños):
   - Dueño: crear proveedor (RUC válido) → editar → ficha.
   - Compra **al contado** → borrador → recibir → stock sube, costo se actualiza sin IGV.
   - Compra **a crédito** → recibir → aparece en **Por pagar** y en la tarjeta del panel.
   - **Pagar** por transferencia → deuda baja, voucher imprime; **pagar en efectivo** sin caja → mensaje; con caja → sale del esperado; cerrar caja → «Pagos a proveedores en efectivo».
   - **Pagar al recibir** (a crédito + casilla).
   - Anular un pago (turno abierto) y anular una compra (con y sin stock/pagos).
   - **Contador**: ve «Por pagar» y descarga el CSV; no ve Proveedores ni Compras ni puede pagar.
   - **Almacenero** sin permiso: no ve Compras; con `compras.registrar`: sí.
   - En el móvil: la barra de navegación (ahora 20 enlaces) se desliza.
3. Acuérdate de que **el QA de los Pasos 4–5** (POS con fiado, clientes y cobranza) sigue pendiente de tu parte.

## Si hay que volver atrás
La migración es **expand-only**: el código anterior ignora lo añadido. Para revertir, **vuelve a desplegar el deployment anterior en Vercel** (no hace falta tocar la base). Las compras y pagos creados con la Fase 4 quedan guardados y vuelven a verse al redesplegar. No hay `down.sql` porque no es destructiva. Restaurar el backup de Neon solo si hubiese corrupción de datos, y eso perdería lo registrado después del backup.

## Riesgos conocidos
- **Neon Free** corta conexiones y tarda en arrancar: la migración y las pruebas pueden fallar por eso (ocurrió varias veces con las pruebas); reintentar solo si el error es de conexión y la migración no quedó a medias (`migrate status`).
- **Las pantallas no se probaron en un navegador real**, ni la impresión del voucher en una ticketera, ni el CSV en Excel: el QA manual de arriba es lo que lo cubre.
- **Pagar en efectivo** exige un turno abierto y lo que hay en caja; un negocio con «caja obligatoria» apagada también lo necesita para este caso.
