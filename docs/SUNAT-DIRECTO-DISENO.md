# Facturación electrónica directa a SUNAT — diseño arquitectónico

> **Estado: APROBADO por el dueño (2026-10-29), con las respuestas de la sección 12. S1 autorizada; S2 en adelante, no.** Reemplaza la vía PSE/OSE (`pse-rest`, pantalla de URL y Token). Las decisiones de la sección 2 las tomó el dueño; todo lo marcado ⚠️ es **normativo y no está validado con fuente oficial**: no se afirma, se confirma antes de implementarlo (regla de `docs/COMPLIANCE.md` §11).

---

## 1. Punto de partida

**Hoy en `main`**

- Emisión por un proveedor (`providers/`): `mock` (demo y pruebas) y `pse-rest` (un intermediario que firma y envía). El negocio configura **URL y Token** del PSE en `/comprobantes` (permiso `config.fiscal`, solo dueño). Token cifrado en `Tenant.pseTokenEnc`, URL en `Tenant.pseEndpointUrl`.
- Ya existen y se **reutilizan**: la máquina de estados `TaxDocument` (`PENDIENTE → ENVIADO → ACEPTADO/OBSERVADO/RECHAZADO`), la cola fiscal con reclamo atómico, *lease* y reintentos (`cola-fiscal/`, worker en `/api/fiscal/worker` con secreto compartido), el modo fiscal (`DEMO / ENSAYO / REAL / PAUSADO`, series de prueba `PB001/PF001`), el generador **UBL 2.1 sin firmar** (`invoicing/ubl.ts`, función pura), las notas de crédito, el cifrado AES-256-GCM por negocio (`lib/cifrado.ts`) y el permiso `config.fiscal` (solo OWNER: el ADMIN no lo tiene, no es opcional, está fuera del PIN).
- Lo que **no** existe: firma digital, cliente de SUNAT, credenciales SOL/certificado, resumen diario, comunicación de baja, guardado del XML firmado y del CDR.

**Rama `fase-1b` (local, nunca desplegada)**: ~3.000 líneas de SUNAT directo — lectura y validación del `.pfx` (`node-forge`), firma XMLDSig (`xml-crypto`), cliente SOAP + ZIP + CDR, lista blanca de endpoints, credenciales cifradas por negocio, alerta de vencimiento, resumen diario y un **SUNAT falso** para pruebas. Salió de un `main` antiguo: sus migraciones (`20261106…`, `20261107…`) quedarían *antes* de las 46 de producción, y su cola/permiso/pantalla chocan con lo de hoy. Solo se probó contra el falso.

## 2. Decisiones tomadas por el dueño

| # | Decisión |
|---|---|
| D1 | **Rescatar `fase-1b` y adaptarla** al `main` actual (migraciones nuevas al final de la cola, permiso y cola actuales). Cada supuesto normativo heredado se revisa contra la fuente oficial. |
| D2 | **Sin intermediario.** El backend genera, firma y envía. Para emitir, la pantalla pide: **certificado digital (.pfx/.p12) + su clave, RUC, usuario SOL secundario + clave SOL**. |
| D3 | **Client ID / Client Secret de la API REST de SUNAT: todavía NO se piden.** Se agregarán cuando F6.9 (guía de remisión) los necesite. |
| D4 | **Solo usuario SOL secundario** (nunca el principal), con permiso limitado a facturación. |
| D5 | **Boletas: la regla vigente la confirma el contador/SUNAT.** El diseño soporta **ambas vías** (resumen diario y envío individual) detrás de una interfaz. |
| D6 | **PSE retirado del todo, en dos pasos**: (1) fuera de UI y código, columnas sin uso; (2) push aparte con migración destructiva que borra `pseEndpointUrl/pseTokenEnc/pseConfiguredAt`. El `mock` se queda para demo y pruebas. |
| D7 | **XML firmado y CDR en la base de datos**, tabla aparte, aislada por negocio. |
| D8 | **BETA por negocio; REAL solo por SuperAdmin** con motivo auditado y tras comprobar certificado vigente, RUC coincidente y prueba de conexión exitosa. La homologación que SUNAT exija la tramita el dueño. |
| D9 | **Clave maestra versionada** (rotable sin pedir otra vez el certificado a nadie). |

## 3. Alcance

**Dentro**: credenciales y certificado por negocio · generación de UBL y **firma XMLDSig** · envío por SOAP (ZIP → `sendBill`) y lectura del **CDR** · facturas, boletas y notas de crédito (y débito si el catálogo ya las emite) · resumen diario (si la regla lo exige) · comunicación de baja · guardado y descarga del XML firmado y del CDR · alertas de vencimiento del certificado · pantalla de credenciales solo dueño · prueba de conexión · pruebas contra el SUNAT falso y un guion manual contra el ambiente BETA.

**Fuera (otra fase)**: guía de remisión electrónica y API REST con OAuth (F6.9) · SIRE/PLE (bloqueado por especificación) · contingencia offline · conciliación contra SUNAT · cualquier regla fiscal no confirmada.

## 4. Arquitectura

```
POS / servicios ──emitir──▶ TaxDocument (PENDIENTE, serie real) ──encolar──▶ FiscalDispatch
                                                                              │ worker (/api/fiscal/worker)
                                       ┌──────────────────────────────────────┘
                                       ▼
  proveedor `sunat-directo` (implementa ProveedorFacturacion)
     1. credenciales del negocio  ──descifrar (en memoria)──▶ clave privada + SOL
     2. ubl.ts (puro)  ──▶ XML sin firmar
     3. sunat/firma.ts ──▶ XMLDSig (RSA-SHA256) dentro de ext:ExtensionContent
     4. sunat/zip.ts   ──▶ ZIP con el XML (nombre normativo ⚠️)
     5. sunat/soap.ts + cliente.ts ──▶ sendBill / sendSummary / getStatus   (solo hosts de SUNAT)
     6. sunat/cdr.ts   ◀── CDR (ZIP) ──▶ código de respuesta → ACEPTADO / OBSERVADO / RECHAZADO
     7. guarda XML firmado + CDR (tax_document_files) y actualiza el TaxDocument
```

- **Módulo `src/features/sunat/`** (de fase-1b, adaptado): `certificado`, `firma`, `zip`, `soap`, `cliente`, `cdr`, `endpoints`, `credenciales`, `proveedor`, `resumen-xml`, `resumenes`, `resumenes-worker`. La emisión **no** conoce los detalles: el `ProveedorFacturacion` sigue siendo el único punto de selección (`providers/index.ts` registra `sunat-directo`; el modo `DEMO` sigue forzando `mock`).
- **Estrategia de boletas** (`EstrategiaBoleta`: `RESUMEN_DIARIO` | `INDIVIDUAL`): una interfaz con dos implementaciones. Cuál rige se fija con una constante documentada **después** de la confirmación oficial (D5). Hasta entonces las boletas se prueban con ambas contra el falso.
- **Errores**: *transitorios* (red, 5xx, timeout, SUNAT caído) → reintento con *backoff* de la cola; *de negocio* (SUNAT rechaza con código) → `RECHAZADO` sin reintento y con el código visible; *de configuración* (sin credenciales, certificado vencido, clave inválida) → el documento queda `PENDIENTE` y la pantalla lo dice con la acción a tomar (no se pierde nada, no se reintenta en bucle).
- **Numeración**: no cambia. Los números reales ya los reserva el modo fiscal (serie real solo en `REAL`); en `BETA` los comprobantes van en serie de prueba y no tienen valor tributario ⚠️ (confirmar con SUNAT cómo se prueban series reales en beta).

## 5. Modelo de datos (expandir; todo aditivo)

1. **`sunat_credentials`** (1 por negocio): `pfxEnc`, `pfxPasswordEnc`, `solUser` (no secreto), `solPasswordEnc`, `ambiente` (`BETA|PRODUCCION`, por defecto `BETA`), metadatos del certificado (`certSubject`, `certIssuer`, `certSerial`, `certRuc`, `certValidFrom`, `certValidTo`), `keyVersion` (con qué versión de clave maestra se cifró), `lastTestAt/lastTestOk/lastTestMessage`, `updatedById`, fechas. Índice por `certValidTo` (alertas).
2. **`sunat_resumenes`** (si D5 lo requiere): como en fase-1b — resumen diario como unidad de trabajo de la cola (envío + consulta del ticket). `TaxDocument.resumenId` (nulo).
3. **`tax_document_files`**: `taxDocumentId` (FK compuesta), `kind` (`XML_FIRMADO | CDR`), `content` (bytea, comprimido), `sha256`, `createdAt`. Único por (`taxDocumentId`, `kind`). Aislada por negocio como el resto (`tenantId` + FK compuesta). El `xmlHash` que ya existe en `TaxDocument` se rellena con el mismo hash.
4. **Contraer (paso aparte, con tu OK)**: `DROP COLUMN` de `tenants.pseEndpointUrl`, `pseTokenEnc`, `pseConfiguredAt`.

Reglas de migración (heredadas de las fases anteriores): `prisma migrate diff`, validada por replay, `down.sql` ensayado sin deriva, nada de `prisma format`, fechas posteriores a la última (`20261124…`).

## 6. Seguridad de las credenciales y del certificado

**Quién**: solo `config.fiscal` (OWNER). El ADMIN no lo tiene, no es opcional ni delegable, está fuera del PIN de operador. **Además**, guardar o quitar credenciales se **niega durante una suplantación** del SuperAdmin (el soporte puede ver metadatos, nunca escribir secretos).

**Qué se guarda y cómo**
- El `.pfx` **no se conserva como archivo**: la acción lo recibe, valida (se abre con la clave, vigencia futura, RUC del sujeto vs. `Tenant.taxId` ⚠️ heurístico; si no coincide, advierte), lo cifra y descarta. Tope de tamaño (p. ej. 64 KB) y rechazo de otros tipos. La clave privada vive en memoria el tiempo justo de firmar y **nunca** se escribe en logs ni en mensajes de error.
- Cifrado AES-256-GCM con el `tenantId` como dato asociado (copiar el cifrado a otro negocio no funciona). **Clave maestra versionada (D9)**: el texto cifrado indica la versión (`v2.<kid>.…`); el entorno lleva el conjunto de claves y cuál es la actual; leer `v1` (formato actual) sigue funcionando. Un script `scripts/recifrar-secretos.ts` (primero en modo *solo mirar*) pasa todo a la versión vigente antes de retirar la clave vieja.
- **Nunca regresan al navegador**: después de guardar solo se muestran metadatos (titular, emisor, vigencia, RUC, usuario SOL enmascarado, ambiente, última prueba). Cambiar = volver a subir. Quitar = borrar la fila (y queda el rastro).
- **Auditoría** (acciones nuevas en `catalogo.ts`): credenciales guardadas / reemplazadas / quitadas, prueba de conexión, cambio de ambiente (con motivo, SuperAdmin), alerta de vencimiento emitida. Sin valores secretos en el registro.
- **SSRF**: lista blanca de hosts de SUNAT (https) y, solo fuera de producción, un servidor local de pruebas. El SUNAT falso no puede usarse en producción aunque alguien escriba su URL.
- **Pantalla**: `/comprobantes` reemplaza el bloque PSE por «Conexión con SUNAT»: pasos (1 certificado, 2 usuario SOL secundario, 3 probar conexión), con un texto claro de cómo crear el usuario secundario ⚠️ (fuente oficial) y el estado de cada paso. Barra de alerta cuando faltan credenciales o el certificado vence en 30/15/7 días o ya venció.

## 7. Ambientes y activación (D8)

| Modo | Qué pasa |
|---|---|
| `DEMO` | Solo el `mock`. Nunca sale nada. |
| `ENSAYO` (sin facturación real) | Serie de prueba; no se envía. |
| `REAL` + `ambiente = BETA` | Se firma y se envía al **ambiente beta de SUNAT**: sirve para probar de punta a punta sin valor tributario. |
| `REAL` + `ambiente = PRODUCCION` | Envío a producción. **Solo lo pone un SuperAdmin**, con motivo, y solo si: certificado vigente, RUC coincidente, usuario SOL cargado y **prueba de conexión OK en los últimos N minutos**. |
| `PAUSADO` | Como hoy: la numeración sigue, el envío espera. |

La homologación/autorización que SUNAT pida para producción ⚠️ la tramita el dueño; este diseño no la sustituye.

## 8. Fases de trabajo (cada una con su commit, barrido, mutaciones, `tsc` y `next build`; push solo con tu orden)

| Fase | Contenido | Despliega |
|---|---|---|
| **S1** | Rescate y adaptación: firma, certificado, zip/soap/cdr, endpoints, SUNAT falso y sus pruebas, sobre el `main` actual. Sin tablas nuevas, sin UI. | no (solo librería probada) |
| **S2** | Clave maestra versionada + `sunat_credentials` + servicio de credenciales + pantalla «Conexión con SUNAT» + alertas + auditoría. Migración nueva. | sí (aditivo) |
| **S3** | Proveedor `sunat-directo` conectado a la cola; `tax_document_files`; facturas y notas de crédito de punta a punta contra el falso. | sí (aditivo) |
| **S4** | Boletas (estrategia de D5) y comunicación de baja, según la regla confirmada. | sí |
| **S5** | Activación: ambiente por negocio, paso a producción por SuperAdmin, guion de prueba manual contra BETA con las credenciales del dueño (que **no** pasan por mí ni por el repo). | sí |
| **S6** | Retiro del PSE (paso 1 en S2/S3; **paso 2 destructivo aparte**). | con tu OK |

Cada fase espera tu confirmación del diagnóstico antes de empezar la siguiente.

## 9. Pruebas

- **Falso local (`tests/falsos/sunat-falso.ts`)**: acepta, rechaza con código, observa, cae (5xx), tarda (timeout), devuelve un CDR corrupto, repite el ticket. Cada camino tiene su prueba.
- **Firma**: el XML firmado se **verifica** con la clave pública del certificado de prueba; una alteración de un byte lo invalida; la firma queda dentro de `ext:ExtensionContent` ⚠️ (confirmar la ubicación oficial).
- **Seguridad**: ningún secreto en respuestas, logs ni mensajes de error (se busca en la salida); el ADMIN y el PIN no pueden; la suplantación no escribe; un negocio no descifra lo de otro; un valor manipulado falla.
- **Rotación**: cifrar con la versión 1, rotar a la 2, leer ambos, re-cifrar, retirar la 1.
- **Mutaciones** en permisos, validación del certificado, lista blanca, clasificación de errores y reintentos.
- Lo que **no** se puede probar sin SUNAT real queda dicho en cada reporte: aceptación real, códigos vigentes, límites de tamaño y de frecuencia.

## 10. Lo que necesito de ti y de las fuentes oficiales (⚠️ bloqueantes)

Nada de esto lo afirmo yo; cada punto se confirma con documento oficial o con tu contador antes de que el código lo dé por hecho:

1. **Documentos oficiales** (pásamelos en `docs/sunat/` o dime dónde están): guía de elaboración de XML UBL 2.1 para factura, boleta, nota de crédito y débito; manual del servicio web de recepción (`sendBill`, `sendSummary`, `getStatus`) con **URLs de beta y producción**; catálogos vigentes; esquemas XSD; norma de firma digital; **cómo se crea el usuario SOL secundario y con qué permiso**.
2. **Boletas**: ¿resumen diario obligatorio, o se pueden enviar una por una? ¿Plazos máximos de envío de boletas y facturas?
3. **Comunicación de baja**: reglas (qué documentos, plazo).
4. **Conservación** del XML firmado y del CDR: plazo legal, para fijar la retención.
5. **Ambiente beta**: cómo se obtiene acceso y qué credenciales usa (tú lo tramitas; no me las des).
6. **Programador externo del worker**: `FISCAL_WORKER_SECRET` y quién llama a `/api/fiscal/worker` cada minuto (QStash/n8n). Sin eso, REAL no envía nada.
7. **Alertas de vencimiento**: ¿solo barra dentro del panel, o también correo al dueño? (hoy no hay envío de correo operativo).
8. **Certificado**: ¿quién lo tramita para cada ferretería (ellas o ustedes como servicio)? Define el texto de ayuda de la pantalla y el flujo de alta.

## 11. Riesgos

- **Normativo** (alto): el formato XML, los códigos, el nombre del ZIP, los plazos y las reglas de boletas pueden diferir de lo que fase-1b supuso. Mitigación: nada se da por válido hasta pasar por el beta de SUNAT; todo ⚠️ visible.
- **Operativo**: el certificado vence y los envíos se detienen en silencio → alertas desde 30 días y el estado del documento lo dice.
- **Secretos**: una filtración de la clave maestra expone todos los certificados → clave solo en el entorno, versionada y rotable; plan de rotación documentado; el KMS externo queda como evolución posible.
- **Volumen**: XML/CDR en la base crecen con el tiempo → se mide y, si hace falta, se mueve a almacenamiento de objetos sin cambiar la interfaz.
- **Vercel**: el envío es un POST largo a SUNAT; el worker ya acota su lote al tiempo máximo de la función y reclama con *lease*.

## 12. Respuestas del dueño a la sección 10 (2026-10-29)

Valores dados por el dueño. Los normativos siguen ⚠️ hasta que suba los PDFs oficiales a `docs/sunat/`; hasta entonces son **constantes de configuración con nombre**, no reglas escondidas en el código.

| # | Respuesta | Qué cambia en el diseño |
|---|---|---|
| 1 | Se asume el UBL 2.1 de `fase-1b`. URLs: beta `https://e-beta.sunat.gob.pe/ol-ti-itcpfegem-beta/billService`, producción `https://e-factura.sunat.gob.pe/ol-ti-itcpfegem/billService`. PDFs oficiales a `docs/sunat/` más adelante. | Lista blanca de hosts con esas dos URLs (S1). Cada catálogo/código heredado queda ⚠️ hasta contrastarlo con los PDFs. |
| 2 | **Boletas: envío individual por defecto** (`sendBill`, como las facturas). Plazo máximo de envío de facturas y boletas: **3 días calendario** desde la emisión. | La estrategia por defecto es `INDIVIDUAL`; el resumen diario **no se construye** salvo que la fuente oficial lo exija (se decide en S4). El plazo de 3 días es una constante (`PLAZO_ENVIO_DIAS`) que la cola usa para avisar de lo que se acerca al límite (S3). |
| 3 | Comunicación de baja: plazo máximo **7 días calendario** desde la emisión. | Constante `PLAZO_BAJA_DIAS` (S4). |
| 4 | Conservación de XML firmado y CDR: mínimo **5 años**. | `tax_document_files` no se purga antes de 5 años (S3); no hay borrado automático. |
| 5 | El dueño gestiona los accesos y credenciales de beta y producción. | Las credenciales nunca pasan por el repositorio ni por mí. |
| 6 | Worker con **Vercel Cron Jobs** cada minuto sobre `/api/fiscal/worker`; `FISCAL_WORKER_SECRET` = UUID largo en `.env.local` y Vercel. | ⚠️ Los crons por minuto exigen un plan de Vercel que los permita; se verifica antes de S5. La ruta ya se autentica con ese secreto compartido. Hay que dejar `vercel.json` con el cron cuando llegue S3/S5. |
| 7 | Alertas de vencimiento: solo barra/banner dentro del panel. Sin correos. | Sin envío de correo (S2). |
| 8 | Cada ferretería compra y tramita su propio certificado; nosotros damos la interfaz para subir el `.pfx`. | Texto de ayuda de la pantalla (S2). |

## 13. Lo que S2 entregó y en qué se apartó del diseño (2026-10-29)

- **Clave maestra versionada**: formato `v2.<kid>.<iv>.<etiqueta>.<cifrado>`; entorno `SECRETOS_CLAVES` (JSON de claves) + `SECRETOS_CLAVE_ACTUAL`; `PSE_MASTER_KEY` sigue valiendo y se toma como la clave «1» (y la rotación de siempre con `_PREVIOUS` sigue leyendo). Lo `v1` se lee con cualquier clave configurada. `scripts/recifrar-secretos.ts` (solo mira por defecto; `--aplicar` escribe de a un registro comprobando que lo escrito se lee).
- **`sunat_credentials`** (migración `20261125100000_sunat_credenciales`, aditiva) con CHECK que impiden guardar un secreto sin cifrar. **Desviación**: no lleva columna `keyVersion`; la versión de la clave va dentro del propio texto cifrado (una sola fuente de verdad, imposible que columna y dato se contradigan).
- **Servicio y pantalla «Conexión con SUNAT»** (3 pasos), solo `config.fiscal`; guardar y quitar se niegan durante una suplantación; siempre nace en BETA; barra de vencimiento solo en el panel y solo para quien tiene `config.fiscal`; auditoría sin secretos; «Probar conexión» con freno de 15 s (⚠️ #13).
- **PSE en pantalla retirado** (paso 1 de D6): sin `PseConfig` ni sus acciones. El servicio `pse-config.ts`, el proveedor `pse-rest` y las columnas `Tenant.pse*` siguen hasta S3 (cuando el proveedor `sunat-directo` los reemplace) y el borrado destructivo, que es un push aparte.

## 14. Lo que S3 entregó y en qué se apartó del diseño (2026-10-30)

- **Proveedor `sunat-directo`** (`sunat/proveedor.ts`) conectado a la cola real: factura, **boleta (envío individual, sin resumen diario)** y **nota de crédito** por el mismo `sendBill`; firma, ZIP, SOAP, CDR; devuelve el XML firmado y el CDR. Acceso denegado = error de configuración (el comprobante sigue PENDIENTE); caída/ilegible = reintento; rechazo = definitivo.
- **`tax_document_files`** (migración `20261126100000_archivos_fiscales`): se guarda, en la misma transacción que el cambio de estado, el XML firmado y el CDR; inmutables (índice único + disparador), comprimidos, con huella verificada al leer; descarga en `/api/comprobantes/[id]/archivo?tipo=xml|cdr` y enlaces en la lista de comprobantes.
- **Plazos como constantes** (`sunat/plazos.ts`): 3 días de envío, 7 de baja, 5 años de conservación (⚠️ del dueño, sin verificar). El aviso crítico de «sin enviar» (72 h) ahora se deriva del plazo de envío.
- **PSE retirado del código**: `pse-rest`, `pse-config`, `sandbox-hosts`, `scripts/certificar-nota.ts` y sus pruebas ya no existen; las columnas `Tenant.pse*` siguen en la base para el paso destructivo final.
- **Desviación**: los comprobantes reales NO se envían mientras la conexión esté en el ambiente BETA (quedarían «aceptados» aquí sin existir ante SUNAT); producción la activa el SuperAdmin en S5 (supuesto #18). Por eso nada sale a SUNAT hasta S5 aunque las credenciales estén cargadas.

## 15. Lo que S4 entregó y en qué se apartó del diseño (2026-10-30)

- **Comunicación de baja de punta a punta** (`sunat/baja.ts`, `sunat/baja-xml.ts`, `cola-fiscal/procesar-baja.ts`): la persona con `comprobantes.dar_baja` (permiso nuevo, otro poder que emitir una nota de crédito; dueño y administrador lo traen) pide la baja de una **factura** (o nota de serie F) ya ACEPTADA u OBSERVADA con un motivo (≤ 100 caracteres). Se le asigna `RA-AAAAMMDD-N` y queda **PENDIENTE** en su propia cola; el worker la firma y la envía (`sendSummary`), guarda el **ticket** y el **XML firmado** (ENVIADA) y luego pregunta por el ticket (`getStatus`); con el **CDR** de código 0 pasa a ACEPTADA y, en la **misma transacción**, el comprobante pasa a **ANULADO** (con fecha y motivo). Un CDR de rechazo deja la baja RECHAZADA y el comprobante intacto.
- **Plazo de 7 días calendario, estricto** (`PLAZO_BAJA_DIAS`, `dentroDelPlazoDeBaja`): el día de emisión es el 0 y el 7.º posterior es el último válido, en la zona del negocio. Se comprueba al pedir y **otra vez antes del primer envío**: si la cola tardó y el plazo venció, la baja se cierra RECHAZADA **sin llamar a SUNAT** y el comprobante queda como estaba (se corrige con una nota de crédito).
- **Cola propia** (`tax_voids`, migración `20261127100000_comunicacion_baja`): no comparte `fiscal_dispatches` (un comprobante ya tiene su fila de envío, única). Misma disciplina: reclamo atómico, **lease** de 2 min, **cerco** (solo el dueño del lease cierra), rampa de 6 intentos (inmediato, 1 min, 5 min, 30 min, 2 h, 12 h), AGOTADA visible (con auditoría) y nunca «rechazada» por no haber respuesta; «en proceso» y los 5xx reprograman, no resuelven. **Mismo identificador en cada reintento**, y como mucho **una baja viva por comprobante** (índice único parcial); una rechazada se puede volver a pedir con un número nuevo. Una AGOTADA con ticket no se reemplaza: se **reintenta su consulta** (`reintentarBaja`).
- **Archivos fiscales de la baja** (`tax_void_files`): el XML enviado (se guarda al recibir el ticket) y el CDR del ticket (al resolver), con **la misma garantía de S3**: una vez por tipo, comprimidos, con huella SHA-256 verificada al leer, inmutables (índice único + disparador), sin borrado automático; descarga en `/api/comprobantes/[id]/archivo?tipo=baja-xml|baja-cdr`. Aislados por negocio.
- **Pantalla**: botón «Dar de baja» (desactivado con el motivo cuando no procede, y oculto en boletas y pruebas), diálogo con motivo obligatorio y confirmación, estado de la baja bajo el comprobante (con enlaces al XML y al CDR) y «Reintentar la baja» si quedó sin respuesta.
- **Desviaciones y decisiones propias** (todas ⚠️ en `SUNAT-SUPUESTOS.md` #19–#27): (1) una comunicación = un comprobante; (2) las **boletas no se dan de baja** por aquí (van en el resumen diario, que no existe todavía); (3) no se da de baja una factura con una **nota viva**; (4) dar de baja es **solo fiscal**: la venta, el stock y el dinero no se tocan (para devolver mercadería está la devolución); (5) el contrato `ProveedorFacturacion` ganó `comunicarBaja` y `consultarBaja` (dos tiempos); `anular` (una llamada) queda para los simulados y en SUNAT directo lanza un error claro; el proveedor simulado no comunica bajas (las cuentas demo no dan de baja ante SUNAT).
- **No probado** (hace falta SUNAT beta): que SUNAT acepte este XML `VoidedDocuments` y el nombre `RUC-RA-…`, la semántica real de `sendSummary`/`getStatus` para bajas, qué comprobantes admite realmente, el plazo y la forma de contarlo, y los códigos de la respuesta. Se probó contra el SUNAT falso (que ahora acepta nombres `RC` y `RA`).

## 16. Lo que S5 entregó y en qué se apartó del diseño (2026-10-30)

- **Interruptor exclusivo del SuperAdmin** (`superadmin/produccion-sunat-service.ts`, acciones `previsualizarPaseSunatAction` y `setAmbienteSunatAction`, ambas con `requireSuperAdmin()` antes de tocar nada y motivo obligatorio de 10 caracteres): pasa la conexión de un negocio de **BETA a PRODUCCION**, o la devuelve. Ningún otro código escribe `PRODUCCION` (el dueño, al cargar un certificado nuevo, vuelve siempre a BETA). Es un poder distinto de «habilitar la facturación real» (serie y envío): aquí se decide a QUÉ SUNAT va lo que se envía.
- **Comprobaciones previas** (todas deben cumplirse; lo que falta se dice junto): RUC válido, facturación real habilitada, clave maestra en el servidor, credenciales cargadas, certificado **vigente** (vence en ≤ 30 días: solo advierte), **RUC del certificado legible e igual al del negocio**, **prueba de conexión exitosa de menos de 24 h**. La pantalla del SuperAdmin muestra la previsualización y no deja confirmar mientras falte algo (⚠️ criterio nuestro: #28).
- **Lo pendiente al cambiar de ambiente**: lo PENDIENTE dentro del plazo de envío (3 días) vuelve a la cola con intentos nuevos; lo que ya superó el plazo queda **RETENIDO** (AGOTADO con el motivo a la vista, también si no tenía fila: se crea retenida para que el worker no lo adopte) y solo sale si una persona lo envía a mano; las bajas pendientes vuelven a la cola (su plazo lo vuelve a comprobar la cola). Los documentos de prueba y los ya resueltos no se tocan. Todo en **una transacción** con el cambio de ambiente y la auditoría (`tenant.sunat.produccion`, con motivo, correo y conteos).
- **Al pasar, la prueba de conexión se borra**: el dueño la repite contra SUNAT real (#29).
- **Camino de vuelta** (`volverASunatBeta`): solo si no salió ningún comprobante ni baja hacia SUNAT real; si ya salieron, se usa «pausar». Se revisa otra vez dentro de la transacción.
- **Arreglo de paso**: `faltantesParaHabilitar` seguía exigiendo «proveedor PSE configurado» (ya imposible tras S2/S3); ahora exige **credenciales de SUNAT cargadas**.
- **No probado**: que la prueba de conexión contra beta anticipe el éxito en producción, el comportamiento real de SUNAT con el usuario SOL de producción, y si enviar tarde lo retenido es aceptable (#28–#30).

## 17. Lo que S6 entregó (cierre del refactor) (2026-10-30)

- **Worker fiscal en el Cron de Vercel, cada minuto** (`vercel.json`: `/api/fiscal/worker`, `* * * * *`). La ruta ya existía (S-previas) y se protege con `FISCAL_WORKER_SECRET` (≥ 16 caracteres; sin él, 503; con otro valor, 401; comparación en tiempo constante; el secreto va **solo en cabeceras**, nunca en la URL). **Cambio:** Vercel Cron solo hace **GET** (antes la ruta solo aceptaba POST y devolvía 405 al GET), así que ahora `GET` y `POST` son el mismo manejador con el mismo control de secreto; un GET sin secreto no hace nada (401/503), de modo que un rastreador o prefetch no lo dispara. **Lo que tú debes configurar en Vercel:** Vercel Cron manda `Authorization: Bearer $CRON_SECRET`, así que `CRON_SECRET` debe valer **exactamente lo mismo** que `FISCAL_WORKER_SECRET` (esto hace que los dos crons compartan secreto) y un cron por minuto exige el **plan Pro**.
- **Migración destructiva `20261128100000_retirar_pse`**: `DROP COLUMN` de `tenants.pseEndpointUrl`, `pseTokenEnc` y `pseConfiguredAt`. Con `down.sql` (devuelve las columnas **vacías**: los datos no se recuperan) y el script de solo lectura `scripts/verificar-pse-sin-datos.ts`, que cuenta (sin imprimir valores) si algún negocio todavía tiene datos del PSE; sale con 3 si los hay.
- **Rastros del PSE retirados**: el re-cifrado de secretos ya no recorre `tenants`; `validarUrlPse` y la variable `PSE_ALLOWED_HOSTS` salieron (queda `esIpInterna`/`validarFormaUrl`, que usa el padrón); fuera `PSE_ALLOWED_HOSTS` y `PSE_SANDBOX_HOSTS` de `.env.example`; las pruebas dejaron de sembrar `pseConfiguredAt`. `PSE_MASTER_KEY` **se conserva**: es el nombre real de la clave maestra de cifrado (kid «1»), no una deuda del PSE. `docs/PSE-SELECCION.md` queda como historia.
- **Con esto el refactor SUNAT directo está completo** (S1–S6). Sigue sin desplegarse: nada de S1–S6 está en producción.
