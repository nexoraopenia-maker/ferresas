# Hoja de ruta — bloque «listo para el mercado»

Pedido el 2026-10-22. Cada punto se entrega en commits separados, con la suite en
verde, `tsc` y build limpios, y con la lista de lo que NO se pudo probar en real.

| # | Bloque | Estado | Depende de |
|---|--------|--------|------------|
| 1a | Escáner de cámara móvil | Hecho (BarcodeDetector nativo + ZXing de respaldo); falta probar en el Android del usuario | Prueba en el celular |
| 1b | Búsqueda predictiva en el POS | Hecho (tildes, resaltado, flechas, estados vacío/error); falta probar sensación en vivo | Prueba del usuario |
| 2a | Guías de Remisión (remitente y transportista) | Por hacer: modelo, UBL DespatchAdvice, series T…, vínculo a venta/traslado | Transmisión real: perfil PSE/OSE |
| 2b | Contabilidad base (registro de ventas y compras, flujo de caja, CxC, CxP) | Por hacer: primero reportes de lectura | Decidido: SÍ se vende a crédito (maestros de obra, pago a fin de mes o por partes): CxC con abonos parciales |
| 3a | Generador de etiquetas (código de barras y QR) | Por hacer | — |
| 3b | Demo ampliada (`demo:crear`) | Por hacer | — |
| 4 | PWA (manifest, service worker, iconos) | Por hacer | — |

## Orden propuesto
1. **1a + 1b** (es un fallo del núcleo del POS).
2. **4** PWA (pequeño e independiente; no cachea datos autenticados).
3. **3a + 3b** etiquetas y demo.
4. **2b** reportes contables de lectura → luego CxC/CxP con modelo nuevo.
5. **2a** guías: modelo y XML sin transmisión real; la transmisión espera al PSE.

## Reglas que no se negocian
- Nada normativo de SUNAT inventado: catálogos (motivo de traslado, modalidad de
  transporte, tipo de documento del conductor…) se marcan ⚠️ en `docs/COMPLIANCE.md`
  hasta tener la fuente oficial.
- Sin dependencias nuevas sin justificar (código de barras y service worker, a mano).
- El service worker NUNCA guarda HTML, datos ni Server Actions autenticados: en un
  celular compartido mostraría el negocio de otra persona.
- Migraciones generadas con `prisma migrate diff` y repetidas en un esquema
  temporal antes de tocar staging o producción.

## En pausa, esperando al usuario
Imagen `public/fondo-login.jpg`; documentación y token del PSE; API del padrón RUC/DNI.


## Plan por fases (aprobado 2026-10-23)

Fase 1 (SUNAT real) se divide: **1A** (sin dependencias externas) y **1B** (perfil del proveedor real, en pausa hasta tener PSE y sandbox).

| 1A | Qué | Estado |
|---|---|---|
| 1A.1 | Ubigeo: cargador con totales de la fuente, selector en cascada con respaldo, requisito de sucursal al emitir, interruptor «facturación real» (apagado, solo SuperAdmin), aviso de la clave al diagnóstico, lista de usos del cliente base | **Hecho** (falta cargar el CSV oficial del INEI) |
| 1A.1b | Rediseño: modo ensayo con serie de prueba, pausar en lugar de apagar, alarma de comprobantes sin enviar, ticket de prueba | **Hecho** (commits expand y código); la migración de DATOS espera el resultado de la consulta de producción |
| 1A.2 | Cola de envío con reintentos, disparada por un programador externo (QStash o similar), tolerante a ejecuciones duplicadas o solapadas | **Hecho** (falta la validación de firmas de QStash y configurar el programador y `FISCAL_WORKER_SECRET`) |
| 1A.3 | Notas de crédito y de débito | Pendiente |
| 1A.4 | Comunicación de baja y resumen diario | Pendiente |
| 1A.5 | Guías de remisión por la misma cola (solo remitente; la de transportista queda fuera) | Pendiente |

**Fase 5 (reportes y SUNAT): cerrada** — F5.1–F5.5 y F5.7 hechas; F5.4 incluye la migración del documento de compra; **F5.6 (PLE) bloqueada** hasta tener la especificación oficial y la validación del contador. Detalle, definiciones, pendientes ⚠️ y lista de QA en `docs/FASE5-CIERRE.md`.

Fases 2 a 9: ver el plan aprobado. Nada se publica hasta que la suite completa esté en verde y se dé la orden.


## Fase 6 — POS e Inventario Pro (roadmap maestro, dado por el dueño el 2026-10-27)

Alcance oficial:
- **Devoluciones** con nota de crédito y reingreso a stock: venta completa (F6.1) y parcial por líneas (F6.2).
- **Kardex** visible por producto, **toma de inventario físico**, **lotes** (opcional: evaluar), **stock mínimo y reposición sugerida**.
- **Listas de precio** (minorista / mayorista) y **precio por volumen**.
- **Movimientos de caja** (gastos / ingresos manuales), **varias cajas por sucursal**, **reporte de cierre mejorado**.
- **Despacho / delivery** sobre pedidos.
- **Generador de etiquetas** (código de barras / QR; el pendiente 3a).
- **Modo offline (PWA)**: ventas en cola que se sincronizan al volver internet, sin duplicar comprobantes.

Orden propuesto (decidido en conjunto; cada subpaso termina con su informe y espera autorización de commit):

| # | Subpaso | Notas |
|---|---|---|
| F6.1 | Anular / devolver una venta completa | **a)** migración + servicio + pruebas · **b)** pantallas (historial de ventas, detalle, cierre de caja). Diseño en `docs/F6.1-DISENO.md` |
| F6.2 | Devolución parcial por líneas + nota de crédito parcial | Depende de F6.1 y de las líneas propias del comprobante (`TaxDocumentItem`, la «fase 1A.3b» marcada en `notas.ts`) |
| F6.3 | Movimientos de caja manuales (ingresos / gastos) | Pequeño y de mucho valor: además **desbloquea** devolver una venta fiada que ya tuvo abonos en turnos cerrados |
| F6.4 | Kardex por producto | Solo lectura sobre `StockMovement`; sirve para verificar F6.1 |
| F6.5 | Toma de inventario físico | Conteos por almacén, diferencias, ajuste aprobado (`stock.ajustar`, origen `CONTEO`) |
| F6.6 | Stock mínimo y reposición sugerida | Desde mínimos y rotación; genera borrador de compra por proveedor o solicitud de transferencia |
| F6.7 | Listas de precio y precio por volumen | Minorista / mayorista; descuento por cantidad |
| F6.8 | Varias cajas por sucursal y reporte de cierre mejorado | Toca el índice «una caja abierta por sucursal», POS, arqueo y cierre: el más delicado de caja |
| F6.9 | Despacho / delivery sobre pedidos | Sobre `Quote` PEDIDO y guías de remisión |
| F6.10 | Generador de etiquetas | Pendiente 3a |
| F6.11 | Modo offline (PWA) | Al final: el más riesgoso. La venta ya es idempotente (`Sale.idempotencyKey`); los comprobantes reales **no se emiten sin conexión** (la venta se encola y se emite al sincronizar) |
| F6.12 | Lotes y vencimientos (evaluar) | Decisión del dueño según su operación; no se asume |
| F6.13 | Cierre de la Fase 6 | Identidades entre kardex, stock, caja y reportes; barrido; checklist de QA |
