# Cierre de la Fase 5: reportes, registros, auditoría y conciliación fiscal

Estado al 2026-10-27. Todo lo de F5.1–F5.7 está en `main` y en producción (F5.4 validada por el dueño). Esta página resume qué se entregó, qué se comprobó, lo que **debe validar el contador** (⚠️) y la lista de verificación para el QA en vivo.

## 1. Qué se entregó

| Pantalla / herramienta | Ruta | Quién (permiso) | Qué hace |
|---|---|---|---|
| Centro de reportes | `/reportes` | `reportes.ver` **o** `productos.ver_costo` (cada tarjeta con el suyo) | Entrada a los reportes |
| Ventas | `/reportes/ventas` (+ CSV `/api/reportes/ventas/[tipo]`) | `reportes.ver` | Por periodo, por vendedor, por medio de pago y cobros (con abonos) |
| Rentabilidad | `/reportes/rentabilidad` (+ CSV) | `productos.ver_costo` | Margen por producto, valor del inventario, ABC, con la cobertura de costo a la vista |
| Registros de ventas y compras | `/reportes/registros` (+ CSV) | `reportes.ver` | Comprobantes y documentos de compra del periodo, con bloque de control |
| Conciliación fiscal | `/reportes/conciliacion` (+ CSV) y `scripts/auditar-fiscal.ts` | `reportes.ver` | Puente ventas → comprobantes → registro, numeración, envíos, notas y compras. Solo informa |
| Auditoría | `/auditoria` | `auditoria.ver` (solo dueño y administrador) | Quién hizo qué, con filtros, cursor y secretos tapados |
| Completar documento de una compra | detalle de la compra | `compras.registrar` | Tipo, serie, número y fecha de emisión, sin tocar stock, costo ni deuda |

Roles de fábrica: **dueño y administrador** lo ven todo; **contador** ve todo menos la auditoría y no puede completar documentos; **cajero, vendedor y almacenero** no ven ningún reporte (el almacenero solo completa documentos si el dueño le activa `compras.registrar`).

Una sola migración en toda la fase: `20261113100000_compras_documento` (aditiva, con `down.sql` ensayado). F5.5 y F5.7 no tocaron el esquema.

## 2. Definiciones que fijan los números
- **Venta** = completada, por la fecha en que se completó, en la hora del negocio (frontera: medianoche de Lima). Anuladas, borradores y devueltas no suman. El fiado cuenta como venta el día de la operación; el abono es un cobro posterior.
- **Venta sin IGV** = total de la línea ÷ (1 + tasa) redondeado a céntimos **como el POS**: la suma coincide al céntimo con `Sale.subtotal`.
- **Margen** = utilidad ÷ venta sin IGV de lo que **tiene costo real**. Costo 0 = «no sé», nunca «gratis»: esa venta queda fuera del margen y la **cobertura** (venta con costo ÷ venta total) se muestra siempre.
- **Registro de ventas**: suma solo ACEPTADO y OBSERVADO; la nota de crédito resta; pendiente, enviado, rechazado y anulado van a un bloque de control; los comprobantes de ensayo y las notas de venta no entran.
- **Registro de compras**: compras recibidas por la **fecha de emisión** del documento; sin documento, la de recepción, marcada **provisional**.
- **Puente de conciliación**: cada venta completada cae en **una** fila; la diferencia sin explicar debe ser **0**.

## 3. Lo que se verificó en el cierre
- **Identidades entre reportes** (`tests/fase5-identidades.ts`, 26 comprobaciones, con ventas hechas por los servicios reales: descuentos, presentaciones, exentos, fiado, pagos mixtos con vuelto, dos cajeros, dos sucursales, comprobantes y notas de crédito, compras con y sin documento y costo): por periodo = por vendedor = por medio = suma de la base; cobros = ventas − fiado; venta sin IGV de rentabilidad = suma exacta de subtotales; el puente parte del total de ventas y llega al registro con diferencia 0 (registro = válidos − notas de crédito); compras de la conciliación = registro de compras = cálculo independiente; las mismas identidades con una sola sucursal.
- **Seguridad** (`tests/fase5-seguridad.ts`, 29 comprobaciones): 23 puntos de entrada × 6 roles (138 combinaciones) permiten o niegan exactamente lo que corresponde; un permiso = un poder (quitar `productos.ver_costo` no quita `reportes.ver` y al revés); ningún informe de `reportes.ver` contiene un costo ni campos de costo, utilidad o margen (JSON ni CSV); aislamiento entre negocios; acotado por sucursal; páginas con su permiso exacto y 404; rutas CSV con 401/403; toda función exportada de los servicios exige permiso; solo `rentabilidad-service.ts` lee costos.
- **Un defecto real encontrado y corregido** al construir las identidades: la **numeración de compras omitía la serie de la sucursal** (`P-00000001`), así que la primera compra de una **segunda sucursal chocaba** con la de la primera («Ese documento del proveedor ya está registrado», mensaje engañoso). Ahora es `P001-00000007` / `P002-…`, como ventas, cotizaciones y transferencias. Las compras anteriores conservan su número `P-0000000N`; no hay migración. Con una sola sucursal en producción nunca se manifestó.

## 4. ⚠️ Pendiente de validar con el contador
Ninguna de estas es una norma de SUNAT: son decisiones de producto aprobadas por el dueño. Hasta validarlas, tómalas como criterio operativo.
1. **Qué estados suman** en el registro de ventas (ACEPTADO y OBSERVADO) y que PENDIENTE, ENVIADO, RECHAZADO y ANULADO queden fuera de los totales, en el bloque de control.
2. **Notas**: la de crédito resta y la de débito suma, en ventas y en compras.
3. **Fecha de las compras**: por emisión del documento; recepción como provisional.
4. **Tipos de documento de compra** (factura, boleta, nota de crédito, nota de débito, recibo por honorarios, otro): sin códigos del catálogo oficial.
5. **Umbrales de tiempo**: 24 h advierte, 72 h es error, para lo pendiente de emitir o de enviar (`UMBRAL_ADVERTENCIA_HORAS`, `UMBRAL_ERROR_HORAS`). **No son plazos de SUNAT.**
6. **Estos registros NO son el PLE.** No hay formato PLE (F5.6 bloqueada hasta tener la especificación oficial vigente y la validación del contador).
7. **Margen sobre venta** (no sobre costo), costo sin IGV, inventario valorizado **a hoy** con el costo promedio actual (no hay historia de costos), ABC con cortes 80 % / 95 % (criterio de gestión).
8. **Numeración**: huecos medidos desde el arranque configurado del contador de cada serie.
9. Un comprobante **ANULADO** (viene del proveedor) no suma; no se cruza con la venta.

## 5. Fuera de alcance (a propósito)
Formato PLE · emisión directa a SUNAT, firma y certificados (en pausa) · descarga CSV de la auditoría · corregir datos desde la conciliación (solo informa) · acotar la auditoría por sucursal (exigiría `branchId` en `AuditLog` y una migración).

## 6. Despliegue de lo último de F5.8
Solo código: la corrección de la numeración de compras y las pruebas. **Sin migración.** Tras el despliegue: `/api/diagnostics?key=$CRON_SECRET` debe seguir con `"ok": true` y 34 migraciones aplicadas, sin pendientes; en el log del build, `[build] PRODUCCION…` y «No pending migrations to apply».

## 7. Lista de verificación para el QA en producción
Marca cada punto. Usa un negocio con datos reales pequeños o el tuyo.

**A. Dueño**
- [ ] `/reportes` muestra 4 tarjetas: Ventas, Registros, Conciliación y Rentabilidad.
- [ ] **Ventas**: «Hoy», «Este mes» y un rango; el total de «Por periodo» = «Por vendedor» = «Por medio». Compáralo con lo que sabes de caja del día. Descarga el CSV y ábrelo en Excel (acentos bien, `;` separa columnas, decimales con punto). Una venta anulada no aparece.
- [ ] **Rentabilidad**: el aviso de cobertura muestra el porcentaje real; «Vendido sin costo» enlaza a `/costos`; un producto sin costo dice «— sin costo»; cambia los cortes del ABC (p. ej. 70 / 90) y la clasificación cambia; el valor del inventario es razonable frente a tu inventario; el CSV de inventario deja vacío el costo de lo que no tiene.
- [ ] **Registros → Ventas**: el total solo suma aceptados y observados; si hay pendientes o rechazados, salen en «Fuera de los totales»; una nota de crédito aparece en negativo y dice qué comprobante corrige. **Compras**: una compra antigua sin documento sale con «provisional» y el aviso.
- [ ] **Completar documento**: abre una compra **recibida** sin documento → «Completar documento» → tipo, serie, número y fecha → guarda. Comprueba que el **stock, el costo del producto y la deuda del proveedor no cambian**, que la compra sale de «provisional» en el registro y que queda una línea en Auditoría («Documento de una compra completado»).
- [ ] **Conciliación**: elige el mes. Debe decir «Todo cuadra.», o listar hallazgos con su explicación. La **diferencia sin explicar es 0**. Si tu negocio sigue en **modo ensayo**, debe decir «Sin comprobantes reales que conciliar en este periodo.» **sin ningún aviso rojo**. Descarga el CSV.
- [ ] **Script (solo lectura)**: `npx tsx scripts/auditar-fiscal.ts --negocio <tu-slug>` con el entorno de producción en la línea de comandos. Sale 0 si no hay errores, 3 si los hay. No escribe nada.
- [ ] **Auditoría** (`/auditoria`): filtros por tipo y por quién; «Ver más antiguos»; abre un registro y mira «Antes» y «Después». **Busca una configuración del proveedor de facturación (si existe) y confirma que token y claves salen como ««oculto»»**. Lo hecho por soporte lleva la marca «Soporte».
- [ ] **Compras en dos sucursales** (si tienes dos): registra una compra en cada una; los números deben ser `P001-…` y `P002-…` y las dos deben guardarse.

**B. Contador** (usuario con ese rol)
- [ ] Ve Reportes (ventas, registros, conciliación y rentabilidad). **No** ve «Auditoría» en el menú y `/auditoria` da 404. No ve «Completar documento».

**C. Cajero / vendedor / almacenero**
- [ ] «Reportes» no aparece en el menú; `/reportes`, `/reportes/ventas`, `/reportes/rentabilidad`, `/reportes/registros`, `/reportes/conciliacion` y `/auditoria` dan 404.
- [ ] Un enlace de descarga CSV pegado a mano responde 403 (no descarga nada).

**D. Administrador de una sola sucursal** (si lo tienes)
- [ ] Sus reportes, registros y conciliación muestran solo su sucursal. La **auditoría muestra todo el negocio** (alcance documentado).

**E. Después**
- [ ] `/api/diagnostics` con `"ok": true`.
- [ ] Pendientes tuyos de fases anteriores: ejecutar `scripts/limpiar-credito-prueba.ts` en producción (primero simulacro, con respaldo), el QA de los Pasos 4 y 5 de crédito, y validar con tu contador la sección 4.

**Si algo falla:** anota la ruta, el rol, el periodo y lo que esperabas; no repitas a ciegas. Los CSV y las pantallas son de solo lectura, salvo «Completar documento» y la línea de auditoría de cada descarga.

## 8. Límites conocidos
Un comprobante rechazado solo se advierte (no sabe si ya se resolvió con otro) · la numeración se revisa sobre toda la historia de la serie, no por periodo · se leen hasta 2000 comprobantes abiertos · no existe todavía el flujo de anular o devolver una venta (la conciliación lo vigila para cuando exista) · una nota de crédito de compra con la misma serie y número que una factura del mismo proveedor chocaría (en la práctica las series difieren) · las tablas muestran las primeras 200 filas; los totales y el CSV son de todas.
