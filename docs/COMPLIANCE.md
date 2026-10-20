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
| ⚠️ **No se valida contra el catálogo del INEI** | Un ubigeo mal tecleado pasa |
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
