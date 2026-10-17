# Facturación electrónica: dos caminos

Comparación para decidir cómo emitir de verdad ante SUNAT. **No se ha escrito
código de ninguna de las dos vías**: esto es para que elijas.

> ⚠️ **Sobre las fuentes.** Lo normativo de aquí viene de blogs de
> proveedores de facturación (que tienen interés comercial en la respuesta) y
> de páginas de orientación de SUNAT. Hay al menos **dos puntos donde las
> fuentes se contradicen** y están marcados abajo. Antes de firmar nada,
> confírmalo en sunat.gob.pe o con tu contador. No he inventado ningún dato
> normativo, pero tampoco puedo certificar los que no pude verificar en la
> fuente oficial.

---

## Las cuatro modalidades que existen

| Modalidad | Qué es | Sirve para FerreSaaS |
|---|---|---|
| **SEE-SOL** | Emitir a mano desde el portal de SUNAT | No: no es integrable |
| **Facturador SUNAT** | Aplicación de escritorio que SUNAT entrega | No: no es multi-tenant ni web |
| **SEE-Del Contribuyente** | Tu propio sistema firma y envía | **Opción (b)** |
| **SEE-OSE / PSE** | Un tercero autorizado firma, valida y envía | **Opción (a)** |

Diferencia entre PSE y OSE, que se confunden: un **PSE** emite y firma *por
cuenta* del contribuyente; un **OSE** *valida* el comprobante antes de que
llegue a SUNAT. Al PSE se lo designa desde SUNAT Operaciones en Línea.

---

## (a) Integrar con un PSE/OSE por API

**Cómo funciona.** FerreSaaS les manda el comprobante (su JSON o su XML),
ellos firman con el certificado, lo envían y devuelven el CDR (Constancia de
Recepción). El estado vuelve por su API o por webhook.

### Esfuerzo
**Bajo-medio: 2 a 4 semanas.** Lo que hay que construir:
- Un cliente HTTP por proveedor, con reintentos e idempotencia.
- Traducir nuestro `TaxDocument` a su formato.
- Recibir el CDR y mapearlo a `TaxDocumentStatus` (la máquina de estados
  `PENDIENTE → ENVIADO → ACEPTADO/RECHAZADO` **ya existe**).
- Guardar el XML firmado y el CDR que ellos devuelven.
- Resumen diario y comunicación de baja: casi siempre son endpoints suyos.

### Riesgo
**Bajo en lo técnico, medio en lo comercial.**
- Ellos absorben los cambios de norma de SUNAT. Es el beneficio principal.
- Dependencia de un tercero: si se cae, tus clientes no emiten.
- Riesgo de *lock-in*: cada proveedor tiene su formato propio. Mitigable
  poniendo una interfaz nuestra y el proveedor detrás.

### Qué tienes que tramitar
- **Certificado digital** por cada cliente ferretero (no uno tuyo). Algunos
  PSE lo incluyen o revenden.
- **Clave SOL** del cliente, para designar al PSE. ⚠️ Es una credencial
  sensible: hay que pedirla, guardarla **cifrada** y mantenerla.
- **Homologación: probablemente NO.** ⚠️ Esto lo afirma un blog de un OSE,
  que es parte interesada. **Confírmalo.**

### Costo operativo
Por comprobante o por paquete mensual. **No conseguí precios verificables en
esta búsqueda** y no voy a inventarlos: pide cotización a 2-3 proveedores. Es
costo variable que crece con tus clientes, y hay que meterlo en el precio de
tus planes.

### Rechazos, reintentos y bajas
- **Rechazo:** devuelven el código de error de SUNAT. Hay que exponerlo al
  usuario — `TaxDocument.statusMessage` ya existe para eso.
- **Reintento:** su API suele ser idempotente por serie-correlativo. Encaja
  con nuestro `@@unique([tenantId, documentType, series, correlativo])`.
- **Baja:** endpoint suyo. Nosotros guardamos el ticket y el resultado.

---

## (b) Envío directo propio (UBL 2.1 + XAdES + SEE)

**Cómo funciona.** FerreSaaS genera el XML UBL 2.1, lo firma con el
certificado de cada cliente, lo comprime y lo envía al web service de SUNAT.
Nosotros interpretamos el CDR.

### Esfuerzo
**Alto: 3 a 6 meses, y no termina nunca.** Lo que hay que construir:
- Generador de XML **UBL 2.1** por tipo de documento, con los catálogos de
  SUNAT (tipo de documento, unidad de medida, tipo de afectación del IGV,
  moneda, motivos de nota de crédito…). Decenas de campos obligatorios y un
  XSD que rechaza por detalles.
- **Firma XAdES-BES** sobre el XML. Criptografía en producción: hecha mal, es
  un agujero.
- **Gestión de certificados por tenant**, cifrados en reposo, con alertas de
  vencimiento. Un `.pfx` en claro en la base es una fuga de identidad
  tributaria.
- Cliente SOAP del web service, compresión ZIP, parseo del CDR.
- Resumen diario y comunicación de baja: otros dos formatos XML distintos.
- **Homologación ante SUNAT** con documentos de prueba. ⚠️ Según las fuentes,
  esta vía **sí** la exige. **Confírmalo.**
- Mantenimiento perpetuo: cada resolución de SUNAT te toca el generador.

### Riesgo
**Alto.**
- Un XML mal formado = comprobante rechazado = tu cliente no puede facturar.
- La firma digital es el punto donde un error se vuelve silencioso: un XML
  que firma pero no valida se descubre en el rechazo, no al generarlo.
- Custodiar certificados de terceros te convierte en objetivo.
- Toda la responsabilidad normativa es tuya.

### Qué tienes que tramitar
- Certificado digital por cliente, **y tú los custodias**.
- Clave SOL por cliente, para el alta de la modalidad.
- **Homologación** ⚠️ con SUNAT.

### Costo operativo
**Casi cero por comprobante** — es la ventaja real. Pero el costo se va a
ingeniería: alguien tiene que seguir las resoluciones de SUNAT
indefinidamente.

### Rechazos, reintentos y bajas
Todo lo implementas tú: interpretar códigos de error de SUNAT, cola de
reintentos con *backoff*, resumen diario, comunicación de baja. Lo que en (a)
es una llamada HTTP, aquí es un subsistema.

---

## Comparación directa

| | (a) PSE/OSE | (b) Directo |
|---|---|---|
| Tiempo a producción | 2-4 semanas | 3-6 meses |
| Riesgo técnico | Bajo | Alto |
| Costo por comprobante | Variable | ~0 |
| Costo de ingeniería | Bajo y acotado | Alto y permanente |
| Cambios de norma | Los absorbe el proveedor | Tuyos |
| Custodia de certificados | Compartida o del proveedor | **Toda tuya** |
| Homologación | Probablemente no ⚠️ | Sí ⚠️ |
| Dependencia de terceros | Alta | Ninguna |
| Lo que ya tienes sirve | Casi todo | Casi todo |

En ambos casos **el trabajo ya hecho no se tira**: `TaxDocument` con emisor y
receptor congelados, series por establecimiento, correlativos sin huecos,
máquina de estados y la representación impresa de 80 mm valen para las dos.

---

## Recomendación: **(a) PSE/OSE**

Tres razones, en orden de peso:

**1. Hoy tus clientes emiten documentos que para SUNAT no existen.** Eso es
riesgo legal *ahora*. La opción (a) lo cierra en semanas; la (b) los deja
expuestos meses más.

**2. El modelo de negocio no encaja con (b).** No eres un contribuyente
emitiendo lo suyo: eres un SaaS que emitiría por cuenta de *muchos* RUC
distintos. Eso multiplica lo peor de (b) —custodiar un certificado por
cliente, una homologación por cliente— sin multiplicar el beneficio.

**3. El costo variable es un problema bueno.** Pagar por comprobante escala
con tus ingresos y se mete en el precio del plan. Seis meses de ingeniería
son costo hundido antes de tener el primer cliente facturando.

**Cuándo reconsiderar (b):** si el costo por comprobante llega a comerse un
porcentaje serio del MRR, o si necesitas algo que ningún proveedor ofrezca.
Para entonces (a) ya te habrá dejado el dominio aprendido, que es la mitad
del trabajo de (b).

**Lo que haría falta de ti para arrancar (a):**
1. Cotizaciones de 2-3 proveedores (precio por comprobante y si incluyen
   certificado).
2. Confirmar con tu contador si el OSE es obligatorio en tu caso. ⚠️ Las
   fuentes se contradicen: una dice PRICOS > 300 UIT desde el 01/07/2025,
   otra habla de contribuyentes designados.
3. Decidir quién custodia los certificados: el proveedor o nosotros cifrados.

---

## Fuentes

Blogs de proveedores y páginas de orientación. **Ninguna es la norma
publicada**, y de ahí las marcas ⚠️:

- [OSE SUNAT: qué es y cuándo integrarte vía OSE](https://blog.alanube.co/peru/que-es-el-ose-sunat/) — proveedor OSE, parte interesada
- [Factura Electrónica SUNAT 2026 — Guía](https://tramitesperu.com/sunat/factura-electronica/)
- [Facturación Electrónica Perú 2026: Guía Esencial SUNAT](https://cpesunat.com/facturacion-electronica-peru/)
- [Facturación electrónica SUNAT 2026: plazos y paso a paso](https://scrampi.com/blog/como-facturar-electronicamente-peru-sunat/)
- [07. Alta, baja y modificación de establecimientos anexos](https://orientacion.sunat.gob.pe/07-alta-baja-y-modificacion-de-establecimientos-anexos) — SUNAT, orientación
- [R.S. N.° 316-2017/SUNAT](https://www.sunat.gob.pe/legislacion/superin/2017/316-2017.pdf) — SUNAT, norma

Dato de plazo que conviene confirmar: según una de las guías, el comprobante
se envía el día de emisión o hasta **3 días calendario** después (R.S.
000003-2023/SUNAT). ⚠️ No lo verifiqué en la resolución.
