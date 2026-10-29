# SUNAT directo — supuestos sin validar (registro vivo)

Cada fila es algo que el código **supone** y que NO está confirmado con una fuente oficial. El dueño subirá los PDFs oficiales a `docs/sunat/`; al contrastar cada fila se marca ✅ (con la página/sección de la fuente) o se corrige el código. **Hasta entonces el sistema no puede afirmar que SUNAT acepta lo que genera**: lo único demostrado es que habla correctamente con el SUNAT falso de `tests/falsos/`.

Estado a la fase **S1** (librería de firma y cliente; sin tablas ni pantallas).

| # | Supuesto | Dónde está | Fuente que lo cierra |
|---|---|---|---|
| 1 | URLs de recepción: beta `https://e-beta.sunat.gob.pe/ol-ti-itcpfegem-beta/billService`, producción `https://e-factura.sunat.gob.pe/ol-ti-itcpfegem/billService` (**dadas por el dueño**, 2026-10-29). | `sunat/endpoints.ts` | Manual del servicio web de recepción. |
| 2 | URL del servicio de consulta de CDR (`…/billConsultService`, host de producción `ol-it-wsconscpegem`). | `sunat/endpoints.ts` | Manual del servicio web (consulta). |
| 3 | Espacio de nombres SOAP `http://service.sunat.gob.pe`, operaciones `sendBill`, `sendSummary`, `getStatus`, `getStatusCdr`, autenticación `UsernameToken` con usuario = **RUC + usuario SOL**. | `sunat/soap.ts`, `cliente.ts` | Manual del servicio web. |
| 4 | Nombre del archivo y del ZIP: `RUC-TT-SERIE-CORRELATIVO` (`.xml` dentro de `.zip`). | `sunat/cliente.ts` (`nombreBase`) | Guía de nombres de archivos. |
| 5 | Firma XMLDSig: RSA-SHA256 por defecto (SUNAT pudo exigir RSA-SHA1), canonicalización C14N 1.0, referencia al documento completo (`URI=""`) con *enveloped*, `Id="SignatureSP"`, dentro de `ext:ExtensionContent`, certificado en `X509Data`. | `sunat/firma.ts` | Norma/guía de firma digital y de elaboración del XML. |
| 6 | El `.pfx` es del titular, con RUC en el sujeto; el RUC se deduce con una heurística (11 dígitos). La cadena de certificación no se valida. | `sunat/certificado.ts` | Requisitos de certificados admitidos. |
| 7 | CDR: estructura (`DocumentResponse` → `ResponseCode`, `Description`, `ReferenceID`; observaciones en `cbc:Note`) y que `"0"` = aceptado. | `sunat/cdr.ts` | Guía del CDR / `ApplicationResponse`. |
| 8 | Rangos de códigos: 0 aceptado; ≥ 4000 aceptado con observaciones; 2000–3999 rechazo; 0100–0199 acceso/configuración; el resto, excepción. | `sunat/cdr.ts` (`categoriaDeCodigo`) | Tabla oficial de códigos de error. |
| 9 | Estado del ticket: `0` terminó, `98` en proceso, `99` terminó con error. | `sunat/cliente.ts` (`consultarTicket`) | Manual del servicio web (`getStatus`). |
| 10 | Un fallo SOAP `Client`/`Server` y el código dentro del `faultcode` (`soap-env:Client.0102`). | `sunat/soap.ts` (`leerFallo`) | Manual del servicio web. |
| 11 | UBL 2.1 del comprobante (`invoicing/ubl.ts`, de F1): estructura, catálogos 01/06/07/05 y unidades de medida. | `invoicing/ubl.ts` | Guía de XML UBL 2.1 + catálogos + XSD. |
| 12 | **Dado por el dueño (no verificado):** boletas por envío individual (`sendBill`); plazo máximo de envío de facturas y boletas = 3 días calendario; plazo de comunicación de baja = 7 días calendario; conservación de XML y CDR ≥ 5 años. | `docs/SUNAT-DIRECTO-DISENO.md` §12 (se implementan como constantes en S3/S4) | Normas de SUNAT / contador. |

## Dependencias nuevas de S1 (justificación)

| Paquete | Para qué | Por qué no se hace a mano |
|---|---|---|
| `node-forge` | Abrir el `.pfx`/`.p12` (PKCS#12) y extraer la clave privada y el certificado del titular. | Node trae `crypto` pero **no** expone la lectura de PKCS#12; escribirla a mano sería inseguro. |
| `xml-crypto` | Firmar y verificar XMLDSig (canonicalización C14N + enveloped + RSA). | La canonicalización de XML es el punto donde las implementaciones propias fallan en silencio; una firma que "parece" válida pero no verifica rompe cada comprobante. |
| `@types/node-forge` (dev) | Tipos. | — |

Ninguna de las dos hace red ni toca la base de datos. Se fijan con `^` en `package.json` y el `package-lock.json` queda commiteado.
