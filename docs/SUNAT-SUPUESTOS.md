# SUNAT directo — supuestos sin validar (registro vivo)

Cada fila es algo que el código **supone** y que NO está confirmado con una fuente oficial. El dueño subirá los PDFs oficiales a `docs/sunat/`; al contrastar cada fila se marca ✅ (con la página/sección de la fuente) o se corrige el código. **Hasta entonces el sistema no puede afirmar que SUNAT acepta lo que genera**: lo único demostrado es que habla correctamente con el SUNAT falso de `tests/falsos/`.

## Estado tras la primera aceptación en SUNAT BETA real (2026-10-30)

Una **factura de Contado** (un ítem gravado) pasó de punta a punta contra BETA: SOAP, firma RSA-SHA256, XML UBL, ZIP, y CDR aceptado (código 0) leído correctamente. Eso confirma los supuestos marcados ✅ más abajo (#1, #3, #4, #5, #6, #7, #10, #11 en su alcance, #32 para Contado y #33). Los hallazgos que costaron un rechazo o un fallo de lectura: **3244** (faltaba la forma de pago de la factura, #32) y el **ZIP del CDR con carpeta `dummy/`** (#33).

**Sigue SIN probarse contra SUNAT real:** boletas, notas de crédito/débito (#15), forma de pago a Crédito (#32), la consulta de CDR (`getStatusCdr`, #2, #13), `sendSummary`/`getStatus` y por tanto toda la comunicación de baja (#19–#27), la URL de producción, los rangos de código fuera del 0 y el 3244 (#8), «aceptado con observaciones» (#17) y los plazos (#12, #23, #30).

Estado a la fase **S1** (librería de firma y cliente; sin tablas ni pantallas).

| # | Supuesto | Dónde está | Fuente que lo cierra |
|---|---|---|---|
| 1 | ✅ **Confirmado en BETA (2026-10-30) en lo que toca al ambiente de pruebas: la URL beta responde; la de producción sigue sin probarse.** URLs de recepción: beta `https://e-beta.sunat.gob.pe/ol-ti-itcpfegem-beta/billService`, producción `https://e-factura.sunat.gob.pe/ol-ti-itcpfegem/billService` (**dadas por el dueño**, 2026-10-29). | `sunat/endpoints.ts` | Manual del servicio web de recepción. |
| 2 | URL del servicio de consulta de CDR (`…/billConsultService`, host de producción `ol-it-wsconscpegem`). | `sunat/endpoints.ts` | Manual del servicio web (consulta). |
| 3 | ✅ **Confirmado en BETA (2026-10-30) para `sendBill`: el espacio de nombres, el `UsernameToken` con RUC + usuario SOL y la operación funcionan. `sendSummary`, `getStatus` y `getStatusCdr` siguen sin probarse.** Espacio de nombres SOAP `http://service.sunat.gob.pe`, operaciones `sendBill`, `sendSummary`, `getStatus`, `getStatusCdr`, autenticación `UsernameToken` con usuario = **RUC + usuario SOL**. | `sunat/soap.ts`, `cliente.ts` | Manual del servicio web. |
| 4 | ✅ **Confirmado en BETA (2026-10-30) para facturas: SUNAT aceptó el ZIP `RUC-01-SERIE-N.zip` con `RUC-01-SERIE-N.xml` dentro.** Nombre del archivo y del ZIP: `RUC-TT-SERIE-CORRELATIVO` (`.xml` dentro de `.zip`). | `sunat/cliente.ts` (`nombreBase`) | Guía de nombres de archivos. |
| 5 | ✅ **Confirmado en BETA (2026-10-30) con RSA-SHA256: SUNAT aceptó el comprobante firmado (no hizo falta SHA-1).** Firma XMLDSig: RSA-SHA256 por defecto (SUNAT pudo exigir RSA-SHA1), canonicalización C14N 1.0, referencia al documento completo (`URI=""`) con *enveloped*, `Id="SignatureSP"`, dentro de `ext:ExtensionContent`, certificado en `X509Data`. | `sunat/firma.ts` | Norma/guía de firma digital y de elaboración del XML. |
| 6 | ✅ **Confirmado en BETA (2026-10-30) en lo esencial: SUNAT aceptó el comprobante firmado con un certificado real cuyo RUC se lee del sujeto.** El `.pfx` es del titular, con RUC en el sujeto; el RUC se deduce con una heurística (11 dígitos). La cadena de certificación no se valida. | `sunat/certificado.ts` | Requisitos de certificados admitidos. |
| 7 | ✅ **Confirmado en BETA (2026-10-30): el CDR tiene `ResponseCode` 0 y `Description` («La Factura numero …, ha sido aceptada»). Las observaciones (`cbc:Note`) no se han visto.** CDR: estructura (`DocumentResponse` → `ResponseCode`, `Description`, `ReferenceID`; observaciones en `cbc:Note`) y que `"0"` = aceptado. | `sunat/cdr.ts` | Guía del CDR / `ApplicationResponse`. |
| 8 | Rangos de códigos: 0 aceptado; ≥ 4000 aceptado con observaciones; 2000–3999 rechazo; 0100–0199 acceso/configuración; el resto, excepción. | `sunat/cdr.ts` (`categoriaDeCodigo`) | Tabla oficial de códigos de error. |
| 9 | Estado del ticket: `0` terminó, `98` en proceso, `99` terminó con error. | `sunat/cliente.ts` (`consultarTicket`) | Manual del servicio web (`getStatus`). |
| 10 | ✅ **Confirmado en BETA (2026-10-30): el rechazo 3244 llegó como fallo SOAP `Client` con el código dentro y se leyó bien.** Un fallo SOAP `Client`/`Server` y el código dentro del `faultcode` (`soap-env:Client.0102`). | `sunat/soap.ts` (`leerFallo`) | Manual del servicio web. |
| 11 | ✅ **Confirmado en BETA (2026-10-30) SOLO para una factura de Contado de un ítem gravado con IGV: SUNAT la aceptó. Boleta, nota de crédito/débito, otras afectaciones y descuentos siguen sin probarse.** UBL 2.1 del comprobante (`invoicing/ubl.ts`, de F1): estructura, catálogos 01/06/07/05 y unidades de medida. | `invoicing/ubl.ts` | Guía de XML UBL 2.1 + catálogos + XSD. |
| 12 | **Dado por el dueño (no verificado):** boletas por envío individual (`sendBill`); plazo máximo de envío de facturas y boletas = 3 días calendario; plazo de comunicación de baja = 7 días calendario; conservación de XML y CDR ≥ 5 años. | `sunat/plazos.ts` (`PLAZO_ENVIO_DIAS`, `PLAZO_BAJA_DIAS`, `CONSERVACION_ANIOS`); el aviso CRÍTICO de «sin enviar» usa el de envío (72 h); las boletas ya se envían una por una (S3), la baja llega en S4 | Normas de SUNAT / contador. |
| 13 | **Prueba de conexión (S2):** que consultar un comprobante inexistente (`getStatusCdr`) sirva para saber si el usuario y la clave SOL son aceptados; que los fallos de acceso sean los códigos **0101–0106** (más estrecho que la familia 01xx a propósito: «el comprobante no existe» también cae en 01xx) y que cualquier otra respuesta signifique «acceso concedido». | `sunat/cdr.ts` (`CODIGOS_DE_ACCESO`), `sunat/credenciales.ts` (`probarConexionSunat`) | Tabla oficial de errores del servicio web + el primer intento real contra el ambiente beta. |
| 14 | **Usuario SOL secundario (S2):** que exista, que se pueda limitar al perfil de comprobantes electrónicos y que su nombre sea de 3 a 30 letras o números. Lo que la pantalla le dice al dueño sobre cómo crearlo es orientación, no la guía oficial. | `invoicing/components/SunatConfig.tsx`, `sunat/credenciales.ts` | Procedimiento oficial de SUNAT para usuarios secundarios. |

## Dependencias nuevas de S1 (justificación)

| Paquete | Para qué | Por qué no se hace a mano |
|---|---|---|
| `node-forge` | Abrir el `.pfx`/`.p12` (PKCS#12) y extraer la clave privada y el certificado del titular. | Node trae `crypto` pero **no** expone la lectura de PKCS#12; escribirla a mano sería inseguro. |
| `xml-crypto` | Firmar y verificar XMLDSig (canonicalización C14N + enveloped + RSA). | La canonicalización de XML es el punto donde las implementaciones propias fallan en silencio; una firma que "parece" válida pero no verifica rompe cada comprobante. |
| `@types/node-forge` (dev) | Tipos. | — |

Ninguna de las dos hace red ni toca la base de datos. Se fijan con `^` en `package.json` y el `package-lock.json` queda commiteado.

## Supuestos que añade S3

| # | Supuesto | Dónde está | Fuente que lo cierra |
|---|---|---|---|
| 15 | **Nota de crédito** sobre factura (y sobre boleta) se envía por el MISMO `sendBill`, con nombre `RUC-07-SERIE-N` y firma igual que una factura. | `sunat/proveedor.ts`, `invoicing/ubl.ts` | Guía de XML UBL 2.1 para nota de crédito + manual del servicio web. |
| 16 | **Un fallo SOAP de la familia 01xx que no es de acceso** (p. ej. el nombre del archivo mal formado) es del contenido: el comprobante queda RECHAZADO y se corrige emitiendo de nuevo; solo 0101–0106 son «de configuración» (reintentar con otro usuario/clave). | `sunat/proveedor.ts` (`aEmision`), `sunat/cdr.ts` | Tabla oficial de errores. |
| 17 | **Aceptado con observaciones** = código 0 acompañado de notas (advertencias). | `sunat/proveedor.ts` | Guía del CDR. |
| 18 | **El comprobante real no se envía al ambiente BETA** (allí no tiene valor). Mientras la conexión esté en BETA, lo emitido queda PENDIENTE; pasar a producción es del SuperAdmin (S5). | `invoicing/envio.ts` (`elegirProveedor`) | Decisión de diseño D8; cómo se prueba una serie real en beta lo dirá SUNAT/el contador (S5). |

## Supuestos que añade S4 (comunicación de baja)

| # | Supuesto | Dónde está | Fuente que lo cierra |
|---|---|---|---|
| 19 | **Identificador y nombre de la comunicación de baja:** `RA-AAAAMMDD-N` (fecha de generación y número del día, por negocio); el archivo se llama `RUC-RA-AAAAMMDD-N` (`.xml` dentro de `.zip`). | `sunat/baja-xml.ts` (`identificadorDeBaja`), `sunat/proveedor.ts` (`comunicarBaja`) | Guía de elaboración de la comunicación de baja. |
| 20 | **Estructura del XML `VoidedDocuments`:** espacio de nombres, componentes `sac:` (`VoidedDocumentsLine`, `DocumentSerialID`, `DocumentNumberID`, `VoidReasonDescription`), `ReferenceDate` = día de emisión del comprobante e `IssueDate` = día en que se genera la comunicación, y que ESTE XML se firma como los demás (`SignatureSP`). | `sunat/baja-xml.ts` | XSD y guía de la comunicación de baja. |
| 21 | **Una comunicación = un comprobante** (lo hemos elegido nosotros: simplifica el seguimiento; SUNAT admite varias líneas). | `sunat/baja-xml.ts`, tabla `tax_voids` | — (decisión de diseño; no es una regla de SUNAT). |
| 22 | **Qué se puede dar de baja:** facturas y notas de serie F ya ACEPTADAS u OBSERVADAS; las boletas (y notas de boleta) se informan en el resumen diario, que todavía no existe en el sistema. Y que **no** se da de baja una factura con una nota viva (regla nuestra, conservadora). | `sunat/baja.ts` (`motivoDeNoBaja`) | Norma de comunicación de baja vs. resumen diario; el contador. |
| 23 | **Plazo = 7 días calendario** (dato del dueño, #12) y la **forma de contar**: el día de emisión es el día 0 y el 7.º posterior es el último válido; ambos días en la zona horaria del negocio. Se comprueba al pedir la baja y otra vez antes del primer envío (la cola pudo tardar). | `sunat/plazos.ts` (`dentroDelPlazoDeBaja`), `sunat/baja.ts`, `cola-fiscal/procesar-baja.ts` | Norma de comunicación de baja; el contador. |
| 24 | **Largo máximo del motivo:** 100 caracteres (también lo exige la base). | `sunat/baja-xml.ts` (`MOTIVO_BAJA_MAX`), migración | XSD / guía. |
| 25 | **`sendSummary` + `getStatus` valen para la baja** igual que para el resumen diario: el envío devuelve un ticket y la consulta devuelve el estado (#9) y, al terminar, un ZIP con el CDR de la comunicación. Un CDR con código 0 (con o sin observaciones) = baja aceptada; 2000–3999 = rechazada. | `sunat/cliente.ts`, `sunat/proveedor.ts` (`consultarBaja`) | Manual del servicio web. |
| 26 | **Reenviar la misma comunicación** (mismo identificador, mismo XML) la reconoce SUNAT como la misma y devuelve el mismo ticket; con otros datos la rechaza. Es lo que hace seguro reintentar tras una caída. | `cola-fiscal/procesar-baja.ts` | Manual del servicio web. |
| 27 | **Un fallo al consultar el ticket** (incluido «el ticket no existe») no se toma como baja rechazada: se vuelve a preguntar y, agotados los intentos, queda AGOTADA (se puede reintentar). Solo un CDR de rechazo, o un error de contenido al ENVIAR, cierra la baja como rechazada. | `sunat/proveedor.ts` (`consultarBaja`) | Códigos de error del servicio web. |

## Supuestos que añade S5 (pase a producción)

| # | Supuesto | Dónde está | Fuente que lo cierra |
|---|---|---|---|
| 28 | **Qué hace falta para «estar listo» para producción** es criterio NUESTRO, no una exigencia de SUNAT: certificado vigente (un vencido o aún no vigente impide el pase; uno que vence en ≤ 30 días solo advierte), **RUC legible en el certificado e igual al del negocio** (si no se puede leer, no se pasa: es estricto a propósito, pero puede bloquear un certificado válido cuyo sujeto no traiga el RUC), prueba de conexión exitosa de **menos de 24 h**, facturación real habilitada, RUC válido y clave maestra. | `superadmin/produccion-sunat-service.ts` | El contador y las pruebas con SUNAT beta. |
| 29 | **La prueba de conexión en BETA sirve como prueba previa a producción.** En la práctica el usuario SOL de beta (MODDATOS) y el de producción pueden ser distintos; por eso al pasar a producción la prueba se **borra** y el dueño debe repetirla ya contra SUNAT real. | `superadmin/produccion-sunat-service.ts`, `sunat/credenciales.ts` | Procedimiento de SUNAT para el ambiente de pruebas. |
| 30 | **Lo pendiente al pasar a producción:** lo que sigue dentro del plazo de envío (3 días calendario, #12) vuelve a la cola; lo que ya lo superó se **retiene** (AGOTADO, no se envía solo) para que el contador decida. Que enviarlo tarde sea posible o convenga no está verificado. | `superadmin/produccion-sunat-service.ts`, `sunat/plazos.ts` (`dentroDelPlazoDeEnvio`) | Norma de plazos de envío; el contador. |

## Hallazgos de la prueba real en SUNAT BETA (2026-10-30)

Primera ejecución real de `scripts/probar-sunat-beta-real.ts` (factura, `sendBill`):

| Resultado | Qué quedó confirmado o cambiado |
|---|---|
| **Conexión y credenciales** | ✅ Confirmado contra SUNAT BETA real: la URL de `billService`, el SOAP con `UsernameToken` (usuario = RUC + usuario SOL), el nombre del archivo `RUC-01-SERIE-N.zip` con el XML dentro, la lectura del certificado `.pfx`, y que SUNAT lee la respuesta como un fallo SOAP `Client` con el código dentro (supuestos #1–#4, #6 y #10, en lo que se vio). **Aún sin confirmar:** que acepte la firma (el XML llegó a las reglas de negocio, lo que sugiere que no la rechazó, pero no es prueba), el CDR y los rangos de código. |
| **3244** «Debe consignar la información del tipo de transacción del comprobante» (nodo `/`, valor vacío) | ❌ El XML fue rechazado por regla de negocio. El generador YA llevaba `cbc:InvoiceTypeCode listID="0101"` pero SIN el `listSchemeURI` del catálogo 51 (tipo de operación). |

| # | Supuesto | Dónde está | Fuente que lo cierra |
|---|---|---|---|
| 31 | **Tipo de operación (catálogo 51)** en `cbc:InvoiceTypeCode listID="0101"`. La hipótesis de que el 3244 se debía a este nodo quedó **REFUTADA** (el 3244 era la forma de pago, #32). El nodo, tal como está hoy (con `listSchemeURI` del catálogo 51), fue **aceptado por SUNAT BETA**; no se probó sin el `listSchemeURI`, así que no se sabe si hace falta. | `invoicing/ubl.ts` | Ejemplos oficiales de XML de factura. |
| 32 | **Forma de pago de la factura** (`cac:PaymentTerms`, `cbc:ID` = `FormaPago`, `PaymentMeansID` = `Contado` o `Credito` + una cuota `Cuota001` con `Amount` y `PaymentDueDate`) en las FACTURAS (no en boletas ni notas). ✅ **CONFIRMADO en BETA (2026-10-30)** para Contado: con el bloque SUNAT pasó la validación 3244; sin él (variante de control) la dio. **Sin confirmar:** la forma Crédito (una sola cuota y que el monto sea lo financiado). | `invoicing/ubl.ts` (`formaDePago`), `invoicing/envio.ts` | Para Crédito, un envío en BETA de una factura a crédito. |
| 33 | ✅ **Confirmado en BETA (2026-10-30).** El ZIP del CDR que devuelve SUNAT trae el archivo dentro de una carpeta (`dummy/`); nuestro lector rechazaba cualquier nombre con `/` y la aplicación respondía «no se pudo interpretar» ante un comprobante que SUNAT SÍ había aceptado. Ahora se saltan las carpetas, se acepta una ruta normal (devolviendo solo el nombre del archivo) y se siguen rechazando `..`, `\\`, ruta absoluta y NUL; el lector solo se fía del directorio central. Con eso el CDR se leyó: categoría aceptado, código 0. | `sunat/zip.ts` (`leerZip`) | — |
