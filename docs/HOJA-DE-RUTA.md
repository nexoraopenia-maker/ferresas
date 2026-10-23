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
