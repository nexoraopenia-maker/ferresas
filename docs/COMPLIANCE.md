# Cumplimiento normativo

Este documento recoge **todo lo que depende de una norma externa** (SUNAT,
INEI) y marca con ⚠️ lo que el código **asume sin verificar** contra la fuente
oficial. Nada de lo marcado se ha inventado como dato normativo: o se teclea,
o se deja sin validar a propósito y aquí se dice por qué.

> Regla de este proyecto: **no inventar datos normativos**. Si una norma exige
> un catálogo, un formato o un cálculo que no tenemos verificado, se marca
> aquí en lugar de escribir una aproximación plausible en el código.

---

## 1. Comprobantes de pago

### Lo que SÍ está implementado y verificado

| Requisito | Dónde | Estado |
|---|---|---|
| IGV **extraído** del precio, no sumado | `src/features/pos/sale-service.ts` | ✅ Verificado con pruebas. En Perú el precio de etiqueta incluye IGV: `base = neto / (1 + tasa)` |
| Correlativo **sin huecos** por serie | `claimNextNumber` en `sale-service.ts` | ✅ Verificado con 12 emisiones concurrentes (`tests/pos-invoicing.ts`) |
| Serie por tipo de documento (B boletas, F facturas) | `src/features/branches/series.ts` | ✅ |
| Serie **independiente por establecimiento** | `Branch.seriesNumber` + único `(tenantId, scope, series)` | ✅ Verificado: dos sucursales no pueden emitir ambas `B001` |
| Factura exige RUC del receptor | `src/features/invoicing/service.ts` | ✅ |
| Importe total **en letras** | `src/lib/numero-a-letras.ts` | ✅ Exigido por el Reglamento de Comprobantes de Pago |
| Operación gravada / exonerada separadas | `src/features/printing/queries.ts` | ✅ Una línea con tasa 0 no se declara como gravada |
| Datos del emisor **congelados** al emitir | `TaxDocument.issuerTaxId` / `issuerLegalName` | ✅ Corregir la razón social hoy no altera lo ya emitido |
| Representación impresa (ticket 80 mm) | `src/features/printing/` | ✅ |

### ⚠️ Lo que FALTA y es obligatorio para operar legalmente

| Falta | Impacto | Por qué no está |
|---|---|---|
| ⚠️ **XML UBL 2.1** | Sin esto los comprobantes **no existen** para SUNAT | No implementado. El `TaxDocument` guarda todo lo necesario para generarlo |
| ⚠️ **Firma digital XAdES** con certificado del contribuyente | Un XML sin firmar se rechaza | Requiere gestión de certificados por tenant, cifrados en reposo |
| ⚠️ **Envío a SUNAT u OSE** | Nadie recibe el comprobante | `TaxDocumentStatus` ya modela el ciclo (`PENDIENTE → ENVIADO → ACEPTADO/RECHAZADO`), hoy se actualiza a mano |
| ⚠️ **Código QR en la representación impresa** | Es obligatorio en el comprobante electrónico | **Deliberadamente NO generado.** El QR codifica `RUC\|tipo\|serie\|número\|IGV\|total\|fecha\|tipoDocReceptor\|nroDocReceptor\|hash`. Sin firma no hay `hash`, y un QR con hash inventado es **peor que ninguno**: parece legítimo y no valida |
| ⚠️ **Resumen diario de boletas** | Las boletas se declaran en lote, no una a una | No implementado |
| ⚠️ **Comunicación de baja** | Es el mecanismo para anular una factura no entregada | No implementado |
| ⚠️ **Nota de crédito** | Es la ÚNICA forma de anular un comprobante ya emitido en Perú | No implementado. `TaxDocumentStatus.ANULADO` existe pero no hay documento que lo sustente |
| ⚠️ **Plazos de envío** | SUNAT fija plazos máximos desde la emisión | No se controlan ni se avisa al vencerlos |

### ⚠️ Cambio manual del estado tributario: DEUDA CON FECHA DE CADUCIDAD

Hoy un comprobante puede pasar a `ACEPTADO` **a mano** (`updateTaxStatus`,
permiso `comprobantes.estado_manual`, solo DUEÑO y ADMIN, con motivo
obligatorio de 10+ caracteres y auditoría del estado anterior y el nuevo).

Existe porque **no hay todavía adaptador del PSE**: sin él, es el único modo de
reflejar lo que respondió SUNAT. Pero es **declarar algo que el sistema no ha
comprobado**, y en cuanto exista el adaptador deja de tener justificación:

> ⚠️ **Cuando se implemente el adaptador del PSE, pasar a `ACEPTADO` a mano
> debe exigir el CDR (adjuntarlo o referenciarlo) o desaparecer.** Dejarlo tal
> cual convertiría un puente provisional en una puerta permanente para marcar
> como aceptado un comprobante que SUNAT nunca vio.

Mientras tanto, lo que lo hace defendible:

| Control | Dónde |
|---|---|
| Permiso propio, distinto de anular | `comprobantes.estado_manual` |
| Motivo obligatorio | `updateTaxStatusSchema.motivo` (≥ 10 caracteres) |
| Auditoría con estado anterior y nuevo | acción `taxdocument.status.manual` |
| El listado dice que fue manual y por qué | `statusMessage = "Cambio manual: …"` |
| `ACEPTADO` es terminal | no se puede degradar ni reabrir |

**Lo que NO controla:** que el DUEÑO o el ADMIN digan la verdad. Una
fiscalización contrasta con SUNAT, no con este registro.

### ⚠️ Supuestos sobre formatos

- **Correlativo de 8 dígitos** (`B001-00000123`): es lo habitual y lo que
  acepta SUNAT, pero **no se ha verificado** contra la resolución vigente que
  8 sea el máximo ni el mínimo exigido. `CORRELATIVO_DIGITOS` está en un solo
  sitio (`src/features/invoicing/schemas.ts`) para poder cambiarlo.
- **Serie de 4 caracteres** (letra + 3 dígitos): mismo caso.
- **Tasa de IGV 18 %**: es la vigente, pero vive en `Tenant.taxRate` y
  `Product.taxRate` (no hardcodeada), así que un cambio de tasa no exige
  tocar código. Las operaciones ya emitidas conservan su tasa congelada.

---

## 2. Establecimientos anexos

| Punto | Estado |
|---|---|
| Código de establecimiento de 4 dígitos | Validado por formato (`/^\d{4}$/`) |
| `0000` = casa matriz | Asumido como convención |
| ⚠️ **No se verifica contra el RUC real** | El código se **teclea**, y la UI lo advierte explícitamente (`avisoEstablecimiento`). Investigado: SUNAT expone los establecimientos anexos **solo detrás de la Clave SOL** del contribuyente; la ficha RUC pública no los trae. Las únicas vías serían la Clave SOL del cliente (la llave de su buzón tributario) o un scraper de terceros, de pago y no oficial. `verificarEstablecimiento` queda como punto de enganche |
| Un código no se reutiliza tras dar de baja la sucursal | ✅ Único `(tenantId, establishmentCode)` **sin** índice parcial, a propósito |

---

## 3. Ubigeo (INEI)

| Punto | Estado |
|---|---|
| Formato de 6 dígitos (dep. 2 + prov. 2 + dist. 2) | Validado |
| ✅ **Validación contra el catálogo, cuando está cargado** | Las sucursales y las guías rechazan un ubigeo que no sea un distrito del catálogo. Mientras la tabla esté vacía solo se valida el formato (6 dígitos) y la pantalla cae a un campo de texto con aviso. |
| ⚠️ **El catálogo oficial AÚN NO está cargado** | El sitio del INEI no fue accesible para descargarlo y validar sus totales. Se carga con `scripts/cargar-ubigeo.ts`, que exige los totales de departamentos, provincias y distritos **que declara la fuente** y no escribe nada si no coinciden exactamente, si falta Callao (07) o si los códigos no son los del INEI (RENIEC). Ver `prisma/data/LEEME.md`. |
| ⚠️ **Catálogo NO embarcado, y es deliberado** | Se revisaron los datasets públicos disponibles. El más citado trae **24 departamentos** cuando el ubigeo del INEI tiene **25 códigos de primer nivel** (falta Callao), y su propia documentación advierte que se basa en datos antiguos. Cargarlo haría **imposible** seleccionar una dirección del Callao: una regresión funcional peor que el campo de texto actual. Además hay **dos sistemas de codificación incompatibles** (INEI y RENIEC) y usar el equivocado pondría el ubigeo erróneo en los comprobantes. Pendiente del fichero oficial del INEI |

---

## 4. Lo que está FUERA de alcance por decisión explícita

Decidido con el dueño del producto; no son olvidos:

- **Trazabilidad de lotes y fechas de vencimiento** (y por tanto FEFO y el
  parseo GS1-128 de los AI `10`/`17`). Una ferretería los necesita para
  selladores, pinturas y adhesivos; se dejó fuera de este ciclo.
- **Todo lo farmacéutico y veterinario**: recetas, DIGEMID, DCI/principio
  activo, carnet de mascota, roles `VETERINARIO` y `QUIMICO_FARMACEUTICO`.
  Pertenecen a otro producto, no a FerreSaaS.
- **Facturación electrónica multi-país**: solo Perú.
- **Modo offline completo del POS**: pospuesto, no descartado.

---

## 5. Protección de datos

- Contraseñas con `bcrypt`, nunca en claro ni en logs.
- El correo del usuario **no** se envía a servicios externos salvo a la
  pasarela de pagos que él mismo contrata.
- Ningún secreto en el código: todo en `.env` / `.env.local`, con
  `.env.example` documentado y `.gitignore` cubriéndolos.
- Borrado **lógico** (`deletedAt`) en clientes, ventas, productos y
  sucursales: nunca `DELETE` de algo con historial.
- ⚠️ **Sin cifrado en reposo a nivel de aplicación.** Lo que hay es el
  cifrado del disco de Neon. Cuando entren los certificados digitales para
  firmar XML, esos **sí** tendrán que ir cifrados por tenant: una clave
  privada en claro en la base es una fuga de identidad tributaria.

---

## 6. Facturación electrónica: qué hay y qué falta

Estado a 2026-10-20. **Ningún comprobante de FerreSaaS ha sido aceptado por
SUNAT ni por un OSE.** Lo que existe es la tubería, probada contra un
proveedor simulado.

### Hecho (y probado)

| Pieza | Dónde | Estado |
|---|---|---|
| Series y correlativos por sucursal y tipo, sin huecos | `counter-service.ts`, `claimNextNumber` | Real |
| XML UBL 2.1 sin firmar de factura, boleta y nota de crédito | `ubl.ts` | Generado y bien formado; **no validado** ⚠️ |
| Verificación de totales antes de generar (Σ líneas = totales) | `ubl.ts → verificarTotales` | Real |
| Armado del comprobante desde la venta y el emisor | `envio.ts → cargarComprobanteFiscal` | Real |
| Envío al proveedor, respuesta, estados (incl. OBSERVADO), auditoría, reintentos | `envio.ts` | Probado contra el proveedor simulado **y contra un PSE de pruebas** |
| Adaptador REST de PSE (contrato propio, `docs/PSE-CONTRATO.md`) | `providers/pse-rest.ts` | Probado contra un servidor de pruebas; **sin PSE real** ⚠️ |
| Credenciales del PSE por negocio, cifradas AES-256-GCM | `pse-config.ts`, `lib/cifrado.ts` | Real; necesita `PSE_MASTER_KEY` |
| Defensa SSRF (URL del PSE, IP al conectar, sin redirecciones) | `url-segura.ts`, `lib/http-seguro.ts` | Real |
| Interfaz agnóstica de proveedor (PSE/OSE) | `providers/types.ts` | Real |
| Validación de RUC (largo, prefijo, dígito verificador) y DNI | `documentos.ts` | Real ⚠️ |
| Consulta de padrón RUC/DNI en vivo (2,5 s, caché, cortacircuitos) | `padron.ts`, `padron-http.ts` | Cliente probado contra un servidor de pruebas; **sin fuente real** ⚠️ |
| Representación impresa 80 mm con QR y hash | `printing/`, `qr.ts` | Real; el QR solo sale con el hash real de un comprobante aceptado ⚠️ |

### Lo que NO se ha hecho y por qué

1. **Firma digital.** Se resuelve con el modelo PSE: el PSE firma con su
   certificado y el negocio no sube ningún `.pfx`. Si algún día se firma en
   local haría falta el certificado de cada negocio y una librería de XMLDSig.
2. ⚠️ **Envío real.** El adaptador y el almacén cifrado de credenciales están;
   falta **contratar un PSE** y escribir su *perfil* (traducir
   `docs/PSE-CONTRATO.md` a su API) probándolo en su ambiente de pruebas.
   Hasta entonces un negocio sin PSE configurado NO envía: el comprobante queda
   PENDIENTE, que es la verdad.
3. ⚠️ **Validación del XML.** Contrastarlo con el XSD y las reglas de
   validación de SUNAT (o con el ambiente de pruebas del PSE/OSE elegido).
   Cualquier campo, catálogo o regla de `ubl.ts` puede estar desactualizado.
4. ⚠️ **Trama del QR.** Se implementó la pedida
   (`RUC|TIPO_DOC|SERIE|NUMERO|IGV|TOTAL|FECHA|TIPO_DOC_CLIENTE|NUM_DOC_CLIENTE|HASH|`,
   número a 8 cifras) y solo se imprime con el hash real de un comprobante
   ACEPTADO u OBSERVADO. **No está contrastada con el anexo vigente** de la
   resolución de comprobantes electrónicos: hay que verificarla antes de
   entregar un ticket a un cliente. Dependencia añadida: `qrcode` (generación
   del QR en el servidor).
5. ⚠️ **CDR.** El proveedor devuelve el código de respuesta (`responseCode`);
   no se guarda el archivo CDR ni el XML firmado (no hay dónde).
6. **Resumen diario de boletas y comunicación de baja.** Casi siempre son
   endpoints del proveedor; no se han construido.
7. **Notas de crédito desde la aplicación.** El XML de nota de crédito existe;
   el flujo para emitirla (motivo, comprobante relacionado, numeración propia)
   no.

### Catálogos usados (todos ⚠️ a contrastar con la versión vigente)

- Tipo de documento (catálogo 01): `01` factura, `03` boleta, `07` nota de crédito.
- Tipo de documento de identidad (catálogo 06): `0` sin documento, `1` DNI,
  `4` carnet de extranjería, `6` RUC, `7` pasaporte.
- Afectación del IGV (catálogo 07): `10` gravado, `20` exonerado, `30` inafecto.
  **El producto no guarda su afectación**: una tasa del 0 % se declara
  exonerada (`20`). Confirmar con el contador y añadir el campo si hace falta.
- Tributos (catálogo 05): `1000` IGV/VAT, `9997` EXO/VAT, `9998` INA/FRE.
- Unidades de medida (catálogo 03, códigos UN/ECE): `NIU`, `KGM`, `GRM`, `MTR`,
  `CMT`, `LTR`, `GLL`, `BX`, `PK`, `DZN`, `MIL`, `RO`, `BG`, `SET`, `PR`, `ZZ`.
  SUNAT admite solo un subconjunto; **PLANCHA** no tiene código propio claro y
  va como `NIU`.
- Descuentos: se informan **ya aplicados** al precio de la línea, no como cargo
  o descuento aparte. Confirmar que el tratamiento es el que quiere el PSE.

### Validación de documentos

- **RUC**: módulo 11 con pesos `5,4,3,2,7,6,5,4,3,2` sobre los 10 primeros
  dígitos y prefijos `10, 15, 16, 17, 20`. ⚠️ Se probó contra dos RUC públicos
  (SUNAT y un supermercado) pero no contra una especificación oficial. Pasar la
  validación **no** prueba que el RUC exista ni esté activo; eso lo dice el
  padrón.
- **DNI**: solo 8 dígitos; no se valida el dígito verificador de la tarjeta.
- **Padrón**: ⚠️ las fuentes posibles (padrón reducido de SUNAT, RENIEC por
  convenio, un servicio de terceros de pago) exigen una decisión comercial. En
  producción `PADRON_PROVEEDOR` es `ninguno` y el cajero teclea el nombre.

### Cuenta de demostración

Los datos son ficticios (documentos tipo `00000001`, RUC de prueba con dígito verificador válido). La demo
usa siempre el proveedor simulado y **sus comprobantes no tienen ningún valor**.
El aviso permanente de la interfaz lo dice.

### Deuda conocida

- Estado manual: `updateTaxStatus` permite pasar un comprobante a ACEPTADO a
  mano (con motivo y auditoría). Cuando haya proveedor real, eso debe exigir el
  CDR o desaparecer.
- Deriva cosmética: las columnas `updatedAt` de `branches`, `cash_sessions`,
  `branch_transfers` y `mermas` llevan `DEFAULT CURRENT_TIMESTAMP` en la base y
  Prisma no lo espera. No afecta al comportamiento; una migración
  `DROP DEFAULT` lo limpiaría.

## 7. Guía de Remisión Electrónica (remitente)

**Qué hay:** emisión y numeración (`T001-00000001`, serie por sucursal, sin huecos, con el mismo contador transaccional de los comprobantes), vinculada a una venta, a una transferencia entre sucursales o sin origen (compra / otros). Campos: motivo, modalidad, fechas, peso bruto, bultos, destinatario, partida y llegada (dirección + ubigeo), transportista (público) o vehículo y conductor (privado), y líneas. No se despacha más de lo vendido o enviado (control dentro de la transacción), y una guía anulada no cuenta pero conserva su número.

**Qué NO hay:** la **transmisión a SUNAT**. Ninguna guía sale sola: queda `PENDIENTE`, que es la verdad. Hace falta un proveedor (PSE/OSE) o la integración directa con la API de SUNAT, y no hay ninguno conectado. Tampoco hay guía de **transportista** (GRE-T) ni **representación impresa**.

| | Qué | Estado |
|---|---|---|
| ⚠️ | **Catálogo de motivos de traslado** (`01` Venta, `02` Compra, `04` Traslado entre establecimientos de la misma empresa, `13` Otros) y **modalidad de transporte** (`01` público, `02` privado) | Los códigos de `features/guias/reglas.ts` NO se contrastaron con la fuente oficial vigente. Hay más motivos oficiales (importación, exportación, venta sujeta a confirmación, etc.) que no se exponen. Verificar antes de transmitir. |
| ⚠️ | **Regla de fechas**: el inicio del traslado no puede ser anterior a la emisión | Supuesto razonable, sin confirmar con la normativa. |
| ⚠️ | **Formato de la licencia de conducir** y de la **placa** | Solo se valida que parezcan un código (8–12 y 6–7 caracteres alfanuméricos). |
| ⚠️ | **Qué datos exige la modalidad pública/privada** para cada motivo | Se exige RUC y razón social del transportista (público) o placa, conductor y licencia (privado). Confirmar el conjunto exacto. |
| ⚠️ | **Unidad y precisión del peso** | Kilogramos, 3 decimales. Confirmar la unidad de medida y límites. |
| ⚠️ | **Ubigeo** | Solo el formato (6 dígitos): no hay catálogo embarcado (ver §3). |
| ✅ | Serie `T` + 3 dígitos por sucursal, correlativo sin huecos, aislamiento por negocio y por sucursal, auditoría de emisión y anulación | Probado en `tests/guias.ts`. |

**Anulación:** solo mientras la guía sigue `PENDIENTE` (no se transmitió). Una guía ya enviada se da de baja por el canal del proveedor o el portal de SUNAT.


## 8. Modo fiscal de un negocio: ensayo, real y pausa

Cada negocio está en uno de cuatro modos:

| Modo | Qué numera | ¿Envía a un proveedor? |
|---|---|---|
| **DEMO** | como un comprobante real (B001…), pero solo con el proveedor **simulado** | Nunca a uno real |
| **ENSAYO** (por defecto) | serie de **PRUEBA** `PB001` / `PF001`: sin valor tributario | **Nunca** |
| **REAL** | serie real `B001` / `F001` | Sí |
| **PAUSADO** | serie real (no vuelve a prueba) | No, hasta reanudar |

**Por qué una serie propia para el ensayo.** Los números de una serie real que SUNAT nunca vio dejarían un hueco irrecuperable el día que se enciende, y el cliente se llevaría un papel con aspecto de boleta que no existe. Con la serie de prueba aparte, la serie real nace limpia: al habilitar arranca en 1, o en el correlativo inicial que el dueño haya fijado mientras estaba en ensayo (ese ajuste sigue disponible porque los documentos de prueba no cuentan). Las series de prueba empiezan por «P»: ninguna serie de boleta o factura de SUNAT lo hace.

**El documento de prueba nunca se parece a un comprobante electrónico.** Ticket: título «DOCUMENTO DE PRUEBA», leyenda «SIN VALOR TRIBUTARIO», marca de agua PRUEBA, sin QR, sin hash, sin «validación por SUNAT» y sin la frase «representación impresa del comprobante electrónico». En el listado figura como «Prueba», sin botón de envío, y no cuenta como pendiente. **Nunca llega a un proveedor ni a ninguna cola**: `enviarComprobante` lo rechaza antes de elegir proveedor, y `esEnviable` (único criterio, para la cola de la 1A.2) lo excluye en todos los modos.

**Transiciones (solo SuperAdmin, con motivo, auditadas):** habilitar (ENSAYO→REAL) · pausar (REAL→PAUSADO) · reanudar (PAUSADO→REAL) · volver a ensayo (solo si no se emitió ni un documento en serie real). **«Apagar» ya no existe**: apagar un negocio que ya emite documentos reales haría que sus clientes recibieran documentos de prueba sin valor. Pausar solo detiene el ENVÍO: la numeración sigue siendo real y los comprobantes esperan.

**Para habilitar** hacen falta: RUC válido, proveedor PSE configurado, al menos una sucursal activa y **todas** con dirección completa y un ubigeo válido. Con la facturación real habilitada (también en pausa), emitir exige además que la sucursal esté completa.

**Alarma de comprobantes sin enviar.** Con REAL o PAUSADO: el dueño y el administrador ven una barra en todo el panel, y el SuperAdmin una insignia por negocio, con la cantidad de comprobantes reales sin enviar y la antigüedad del más viejo. La pausa se muestra siempre. ⚠️ **Los umbrales por defecto (24 h de aviso, 72 h crítico) NO son plazos de SUNAT**: son valores de trabajo, configurables por negocio (SuperAdmin) o para toda la plataforma (`FISCAL_ALERTA_AVISO_HORAS`, `FISCAL_ALERTA_CRITICO_HORAS`), a la espera de que el responsable fiscal confirme los plazos que correspondan.

**⚠️ Documentos del modelo anterior.** Un negocio que emitió documentos en serie real **antes** de que existiera el modo ensayo (números de una serie que SUNAT nunca vio, posiblemente entregados a clientes) **no se puede habilitar**: el sistema los cuenta y se detiene. Reubicarlos como pruebas no se hace solo; exige la revisión de un contador, un respaldo, un ensayo en staging con una copia representativa y la confirmación explícita del SuperAdmin. Esa migración de datos NO está implementada.

El criterio para habilitar no es técnico: es haber validado el XML, los catálogos (§6) y la trama del QR en el sandbox del proveedor. Hasta entonces, ⚠️ nada de lo que emite FerreSaaS debe considerarse aceptado por SUNAT.


## 9. Cola de envío: qué garantiza y qué no

**Garantiza:** que ningún comprobante se envíe dos veces desde FerreSaaS aunque haya varios workers o ejecuciones solapadas; que un worker caído a mitad de un envío no deje la fila bloqueada; que nada se marque ACEPTADO sin una respuesta del proveedor; que un documento de prueba jamás llegue a un proveedor; y que un envío que se rinde (AGOTADO) sea visible para el dueño y el SuperAdmin.

**No garantiza** (⚠️): que el proveedor no duplique un comprobante si ignora su clave de idempotencia (la clave se envía, pero que la respete es cosa suya y de su contrato), ni los **plazos** de SUNAT para enviar: los umbrales de la alarma (24 h / 72 h por defecto) no son plazos oficiales y los confirma el responsable fiscal. Tampoco hay todavía envío real: hasta que haya un PSE contratado la cola solo se ha probado contra proveedores simulados.

## 10. Notas de crédito y de débito

Estado: **modelo de datos (`20261104120000_init_notas_credito_debito`), envío por la cola (UBL 07/08) y emisión de la nota de crédito TOTAL (`emitirNotaCreditoTotal`, motivos 01, 02 y 06) listos; ninguno validado con un proveedor real.** Falta la pantalla, las notas parciales y de débito (`TaxDocumentItem`, fase 1A.3b) y la certificación empírica (`scripts/certificar-nota.ts`, que necesita un PSE de pruebas configurado).

La emisión NO devuelve stock, no toca la caja y no cambia la venta; solo crea la nota. Una sola nota total viva por comprobante: índice único parcial `20261105120000_nota_credito_total_unica` (una nota rechazada no cuenta). La serie se hereda del original (`F007` → `FC07`, `B012` → `BC12`) y solo cabe hasta la sucursal 99.

> ⚠️ **Todo lo normativo de esta sección está pendiente de validación oficial.** Los catálogos 09 y 10, la regla de series y los plazos están escritos de memoria para poder construir el modelo; no los ha contrastado ninguna fuente de SUNAT. Antes de habilitar notas a un negocio real hay que cotejarlos con el Anexo de catálogos y la Guía de elaboración del XML vigentes (o con el contador / el proveedor PSE) y quitar este aviso.

### Modelo

- Una nota es un `TaxDocument` con `documentType` `NOTA_CREDITO` o `NOTA_DEBITO`, **serie propia**, su propio correlativo sin huecos y la misma clave fiscal que el resto: `(tenantId, documentType, series, correlativo)`. No se añadió un campo `number`: el número es `correlativo`, y duplicarlo permitiría que se desalinearan.
- `relatedDocumentId`: el comprobante que corrige o aumenta. Clave foránea compuesta con el negocio (una nota nunca apunta al comprobante de otro negocio) y `ON DELETE RESTRICT`.
- `reasonCode` (código de dos dígitos del catálogo) y `reasonDescription` (sustento escrito).
- `saleId` de la nota es la venta de su comprobante relacionado. Por eso se eliminó el único `(tenantId, saleId)`: ahora lo sustituye un **índice único parcial** que impone un solo comprobante de venta (boleta o factura) por venta; las notas no cuentan.
- Un `CHECK` en la base obliga a que una nota lleve comprobante relacionado (distinto de sí misma), código de dos dígitos y sustento, y a que boletas y facturas no lleven ninguno.
- Las notas corrigen, nunca borran: el comprobante original no se modifica.

### Herencia del prefijo de la serie (F / B) ⚠️

La serie de una nota empieza por la **misma letra** que la serie del comprobante que modifica: una nota sobre una factura (serie `F…`) lleva serie `F…`; una nota sobre una boleta (`B…`), serie `B…`. Propuesta de formato: `FC01`/`FD01` (crédito/débito sobre facturas) y `BC01`/`BD01` (sobre boletas). ⚠️ La longitud de cuatro caracteres, la letra de tipo (`C`/`D`) y el correlativo de dos dígitos son nuestra convención y se validan con SUNAT/el PSE. Las notas sobre documentos de prueba (series `PB`/`PF`) **no se admiten todavía** (ver §8).

### Catálogo 09: tipo de nota de crédito ⚠️

| Código | Descripción |
|---|---|
| 01 | Anulación de la operación |
| 02 | Anulación por error en el RUC |
| 03 | Corrección por error en la descripción |
| 04 | Descuento global |
| 05 | Descuento por ítem |
| 06 | Devolución total |
| 07 | Devolución por ítem |
| 08 | Bonificación |
| 09 | Disminución en el valor |
| 10 | Otros conceptos |
| 11 | Ajustes de operaciones de exportación |
| 12 | Ajustes afectos al IVAP |
| 13 | Corrección del monto neto pendiente de pago y/o de las fechas de vencimiento del pago único o de las cuotas y/o los montos correspondientes a cada cuota, de ser el caso |

### Catálogo 10: tipo de nota de débito ⚠️

| Código | Descripción |
|---|---|
| 01 | Intereses por mora |
| 02 | Aumento en el valor |
| 03 | Penalidades / otros conceptos |
| 10 | Ajustes de operaciones de exportación |
| 11 | Ajustes afectos al IVAP |

### Lo que NO está decidido todavía ⚠️

- Qué códigos del catálogo 09 se ofrecen a una ferretería (propuesta inicial: 01 a 07, 09 y 10; fuera de alcance 08, 11, 12 y 13).
- El plazo máximo para emitir una nota sobre un comprobante, y si una nota de crédito total (01/06) debe además anular el comprobante.
- Que una boleta pueda ser corregida con nota o solo anulada por resumen diario (fase 1A.4).
- Reglas de importes: que la suma de las notas de crédito no supere el comprobante relacionado.

### Estado de un comprobante en un negocio real

Con la facturación electrónica activa (real o en pausa) **ningún estado se declara a mano**: ni Enviado, ni Aceptado, ni Rechazado, ni Observado. Lo fija solo la respuesta del proveedor, por la cola fiscal o por «Consultar» (sincronización explícita). El servicio lo rechaza y la lista no lo ofrece. Solo la demo y el ensayo, que no hablan con un proveedor real, conservan el cambio manual. Una nota de crédito exige además que el original lleve el identificador (`externalId`) que le dio el proveedor.

## 11. Reportes, registros y conciliación (Fase 5) ⚠️

Los registros de ventas y de compras y la conciliación fiscal son **herramientas de trabajo para el contador, no el formato oficial**: no generan PLE y no asignan códigos del catálogo de comprobantes de SUNAT. Las reglas de qué estados suman, el trato de las notas, la fecha de las compras y los umbrales de 24 h / 72 h son criterios de producto aprobados por el dueño y están **pendientes de validar con el contador** (lista completa en `docs/FASE5-CIERRE.md`, sección 4). Los comprobantes de ensayo (`isTrial`) y las notas de venta nunca entran a estos registros.
