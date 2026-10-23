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
| 1A.2 | Cola de envío con reintentos, disparada por un programador externo (QStash o similar), tolerante a ejecuciones duplicadas o solapadas | Siguiente |
| 1A.3 | Notas de crédito y de débito | Pendiente |
| 1A.4 | Comunicación de baja y resumen diario | Pendiente |
| 1A.5 | Guías de remisión por la misma cola (solo remitente; la de transportista queda fuera) | Pendiente |

Fases 2 a 9: ver el plan aprobado. Nada se publica hasta que la suite completa esté en verde y se dé la orden.
