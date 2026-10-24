# Fase 1B: elegir un PSE y montar su sandbox

Preparación, sin código ni credenciales. Parte de `docs/PSE-CONTRATO.md` (lo que `providers/pse-rest.ts` espera) y de
`docs/SUNAT-OPCIONES.md` (vía PSE/OSE ya recomendada).

> ⚠️ Nada de aquí está validado con un proveedor real. Los puntos marcados «PREGUNTAR» son datos que solo el
> proveedor puede dar; no se suponen. No se piden ni se guardan credenciales fuera de la pantalla de configuración
> del negocio (token cifrado con `PSE_MASTER_KEY`).

---

## 1. Lista de verificación para elegir el proveedor

Cada punto es una pregunta con respuesta comprobable (documentación o prueba en su sandbox), no una promesa comercial.
**Eliminatorio** = si falla, se descarta; **Pesa** = se puntúa.

### A. Lo que decide si podemos conectarlo (eliminatorio)

| # | Criterio | Cómo se comprueba |
|---|---|---|
| A1 | **API REST con JSON/HTTPS y token** (Bearer o equivalente) | Documentación; una llamada de prueba |
| A2 | **Sandbox propio y gratuito**, separado del de producción, con su propio token | Que entreguen un token de pruebas antes de contratar |
| A3 | **Acepta XML UBL 2.1 sin firmar** (nosotros ya lo generamos) **o** un JSON documentado del que podamos derivarlo | Documentación del endpoint de emisión |
| A4 | **Firma con SU certificado** (el ferretero no sube ningún `.pfx`), o permite custodia suya del certificado del cliente | Contrato; es lo que quita de encima la custodia (ONBOARDING-FISCAL §2) |
| A5 | **Idempotencia**: repetir la misma emisión (misma serie-correlativo) devuelve el mismo resultado, sin duplicar | Probar dos `POST` iguales en el sandbox |
| A6 | **Emite notas de crédito y de débito** (07 y 08) con comprobante relacionado y catálogos 09 y 10 | Documentación + una nota de prueba |
| A7 | **Un solo contrato nuestro para muchos RUC** (modelo SaaS): alta de contribuyentes por API o panel, sin que cada ferretero contrate por su cuenta | Contrato / documentación de «multiempresa» |
| A8 | **Devuelve el CDR** (código y mensaje de SUNAT) y el `DigestValue` de la firma | Respuesta del sandbox |

### B. Lo que decide cuánto trabajo y riesgo tiene el perfil (pesa)

| # | Criterio | Qué buscamos |
|---|---|---|
| B1 | Forma de la autenticación | Token estático; si es OAuth con expiración, hay que escribir renovación |
| B2 | Estados que devuelve | Que se mapeen a `ACEPTADO / OBSERVADO / RECHAZADO / ENVIADO / PENDIENTE` sin ambigüedad |
| B3 | Consulta por id **y** por serie-correlativo | Nuestro `consultarEstado` usa ambos |
| B4 | Descarga de XML firmado, CDR y PDF | `descarga/{xml\|cdr\|pdf}` |
| B5 | Webhooks de estado (opcional) | Si no hay, la cola consulta; funciona igual |
| B6 | Endpoint de salud y **fecha de vencimiento del certificado** | Para avisar antes de que caduque |
| B7 | Baja (comunicación de baja) y resumen diario | Hoy no usamos ninguno; hace falta en la 1A.4 |
| B8 | Códigos de error de SUNAT expuestos tal cual | Para mostrárselos al usuario (`statusMessage`) |
| B9 | Límites de tasa y tamaño | Nuestra cola tiene reintentos y 15 s de tiempo total |
| B10 | Redirecciones | No seguimos 3xx (se tratan como reintentable): que no las usen |

### C. Lo comercial y legal (pesa mucho, no se infiere)

| # | Criterio | PREGUNTAR |
|---|---|---|
| C1 | Precio por comprobante / paquete mensual | Cotización de 2-3 proveedores. Es costo variable: entra al precio de los planes |
| C2 | ¿Cobra las notas de crédito/débito igual que las facturas? | |
| C3 | ¿El certificado está incluido o se revende? ¿Quién lo custodia? | |
| C4 | ¿Hay que designar al PSE desde SUNAT con **usuario SOL secundario** de cada cliente? | Qué perfiles exactos (nunca el principal, ONBOARDING-FISCAL §3) |
| C5 | ¿Hace falta homologación de nuestra parte? | ⚠️ Las fuentes se contradicen (SUNAT-OPCIONES); que lo diga el proveedor por escrito |
| C6 | ¿Es OSE o PSE? ¿Es obligatorio un OSE para alguno de nuestros clientes? | ⚠️ Confirmar con un contador |
| C7 | Disponibilidad (SLA), soporte, qué pasa si se cae | Si se cae, los clientes no emiten: nuestra cola reintenta, pero no emite por sí sola |
| C8 | Salida: ¿podemos exportar todo y cambiar de proveedor? | Evita el *lock-in* |
| C9 | Dónde están los datos y qué hacen con ellos | Protección de datos (COMPLIANCE §5) |

### Puntuación sugerida

Un proveedor pasa a la prueba solo si cumple A1-A8. Entre los que pasan: A8/B2/B3/B8 (cuánto se parece al contrato)
pesan el doble que B4-B10; C1-C9 se evalúan aparte por la persona que firma el contrato. **Se elige con el sandbox en la
mano**, no con la web comercial: el perfil se escribe contra lo que el sandbox responde de verdad.

---

## 2. Especificación del sandbox: qué hace falta y cómo se aísla

### 2.1 Lo que debe entregar el proveedor (PREGUNTAR / recibir por un canal seguro, no por chat)

| Dato | Para qué | Notas |
|---|---|---|
| **URL base del sandbox** (https, host público) | `Tenant.pseEndpointUrl` | Añadirla a `PSE_ALLOWED_HOSTS` |
| **Token de pruebas** | `Tenant.pseTokenEnc` (cifrado) | Lo carga el dueño del negocio de staging **desde la pantalla**; nunca en `.env` ni en el chat |
| **RUC emisor de pruebas** + razón social + domicilio fiscal + ubigeo | `Tenant.taxId` y datos del emisor | El RUC es único en todo el SaaS: solo puede usarlo UN negocio de staging |
| **Certificado de pruebas** | Lo firma el proveedor con el suyo | Confirmar que no pide `.pfx` nuestro; si lo pidiera, se decide la custodia antes de seguir |
| **Series permitidas** en el sandbox | `F001`, `B001`, **`FC01`, `BC01`** | Confirmar que acepta nuestras series de notas (F+C+2 dígitos) o cuáles exige |
| **Receptores de prueba válidos** | RUC y DNI con dígito verificador correcto | Para factura y boleta |
| **Comportamiento del correlativo** | `startNumber` de la serie | ¿Se reinicia el sandbox? ¿Rechaza números repetidos o fuera de orden? |
| **Qué devuelve** | Mapeo a nuestros estados | Un ejemplo real de `ACEPTADO`, `OBSERVADO` y `RECHAZADO` con su `codigo`/`mensaje` |
| **Descarga de XML firmado y CDR** | Evidencia para quitar ⚠️ | Ruta exacta |
| **Límites** | Tasa, tamaño, tiempo | Contra el tope de 15 s y 1 MB |
| **Cómo limpiar** | Reiniciar el sandbox | Para repetir pruebas |

### 2.2 Lo que se monta de nuestro lado (solo staging; nunca producción)

1. **Base**: la rama de staging (`ep-plain-king`), verificada por la guardia de huella (lista blanca). Producción no se toca.
2. **Un negocio dedicado** (`cert-pse` o similar), no los datos de demo:
   - `taxId` = RUC de pruebas del proveedor, `legalName` y domicilio con ubigeo válido.
   - Una sucursal con `seriesNumber` 1 (series F001/B001/FC01/BC01) y su `establishmentCode`.
   - `DocumentCounter.startNumber` ajustado si el sandbox ya tiene números usados (pantalla «Series»).
3. **Facturación real habilitada** para ese negocio, por un SuperAdmin (`habilitar`), tras verificar los requisitos. Sin esto la cola no envía.
4. **Proveedor configurado desde la pantalla del negocio**: URL base + token. Se prueba la conexión (`/salud`), que también devuelve el vencimiento del certificado.
5. **Entorno**: `PSE_MASTER_KEY` válida en `.env.local`, `PSE_ALLOWED_HOSTS` con el host del sandbox, y (si se usa el endpoint del worker) `FISCAL_WORKER_SECRET`.

### 2.3 Aislamiento de lo real (garantías, y una que falta)

- **Base distinta**: lista blanca por huella (ya implementada). Imposible escribir en producción con la suite o `prisma migrate`.
- **Token de sandbox ≠ token real**, y el negocio de pruebas ≠ ningún negocio de cliente.
- **Propuesta (no implementada)**: variable `PSE_SANDBOX_HOSTS`; `certificar-nota.ts` se negaría a enviar si el host del PSE configurado no está en ella. Así no se manda una nota de certificación a un endpoint de producción por error de configuración. ⚠️ A decidir.
- **Una nota emitida en sandbox no se borra**: consume correlativo y (si el sandbox lo registra) queda. Por eso el script exige `--ejecutar` y trae un ensayo por defecto.

### 2.4 Matriz mínima de certificación (qué se envía y qué debe pasar)

| # | Caso | Resultado esperado | Qué se aprende / qué ⚠️ se puede quitar |
|---|---|---|---|
| 1 | Factura F001 normal | `ACEPTADO` | El perfil funciona de punta a punta |
| 2 | Boleta B001 normal | `ACEPTADO` | |
| 3 | Nota de crédito total, motivo 06, sobre la factura | `ACEPTADO` | UBL `CreditNote`, referencia al original, catálogo 09 (código 06), serie `FC01` |
| 4 | Nota de crédito total, motivo 01, sobre una boleta | `ACEPTADO` | Serie `BC01`; código 01 |
| 5 | Nota de crédito, motivo 02 | `ACEPTADO` o rechazo explicado | Código 02 |
| 6 | Reenviar la misma nota (idempotencia) | Mismo resultado, sin duplicar | A5 |
| 7 | Nota sobre un original que el proveedor no conoce | `RECHAZADO` con código | Mensaje de rechazo mostrable |
| 8 | Serie de nota incorrecta a propósito | `RECHAZADO` | Que el rechazo sea definitivo (no reintentable) |
| 9 | Cortar la red a mitad (token inválido) | Error de configuración, estado intacto | 401/403 no cambia el estado |

**Evidencia por caso**: XML enviado, JSON enviado, respuesta tal cual, XML firmado y CDR descargados. `certificar-nota.ts`
guarda las dos primeras en `tmp/certificacion/`. **Solo se quita un ⚠️ de `COMPLIANCE.md` con una respuesta `ACEPTADO` del
proveedor que lo cubra**; un rechazo no quita nada.

---

## 3. Pantalla de emisión de notas de crédito (borrador, sin programar)

### Dónde vive
En `/comprobantes`, dentro de la lista. Una acción por comprobante, no una pantalla aparte: el contador ya está ahí.

### Estructura de componentes

```
app/(dashboard)/comprobantes/page.tsx          (servidor)
  · añade al select: relatedDocument{fullNumber}, reasonCode, y si el comprobante YA tiene una nota total viva
  · calcula puedeEmitirNota = puede(ctx,'comprobantes.anular') && access FULL|WARN
  └─ TaxDocumentList.tsx                       (cliente, existente)
       · fila de BOLETA/FACTURA: botón «Nota de crédito» (según reglas abajo)
       · fila de NOTA_CREDITO: «Modifica a F001-…» y «Motivo 06 · Devolución total»; sin «Emitir guía»
       └─ EmitirNotaCreditoDialog.tsx          (cliente, nuevo; usa components/ui/dialog.tsx)
            · MotivoSelect (01, 02, 06 con su explicación)
            · SustentoField (3-250 caracteres, contador)
            · AvisoDeAlcance + casilla «Entiendo que no se puede deshacer»
            · ResultadoNota (número emitido, estado Pendiente, «se enviará solo»)
invoicing/motivos-nota.ts                      (puro; catálogo 09 SOLO 01/02/06, textos, ⚠️)
invoicing/schemas.ts                           + emitirNotaCreditoSchema (zod: saleId, reasonCode ∈ {01,02,06}, sustento)
invoicing/actions.ts                           + emitirNotaCreditoAction  (withTenant → emitirNotaCreditoTotal → revalidatePath)
```

El permiso se comprueba **otra vez en el servicio** (`comprobantes.anular`), no solo en la interfaz.

### Cuándo se ofrece el botón
Solo si **todo** esto es cierto; si no, se muestra desactivado con la razón:
- tipo BOLETA o FACTURA, **real** (no `PB/PF`), estado **ACEPTADO**: «Disponible cuando SUNAT acepte el comprobante»;
- no tiene ya una nota total viva: «Ya tiene la nota FC01-…»;
- serie derivable (sucursal 1 a 99);
- el usuario tiene `comprobantes.anular`.

### El modal (qué dice y qué exige)
1. **Resumen de solo lectura**: número, cliente, fecha, total. Es lo que se anula, por el importe completo.
2. **Motivo** (lista de tres): 01 *Anulación de la operación* · 02 *Anulación por error en el RUC* · 06 *Devolución total*, con una línea de ayuda cada uno. ⚠️ Nombres del catálogo 09 sin validar.
3. **Sustento** (obligatorio, 3-250): saldrá en la nota.
4. **Aviso de alcance**, en voz alta: «Esta nota anula S/ 118.00 del comprobante F001-… por completo. **No devuelve el stock ni el dinero**: eso se hace aparte».
5. **Confirmación explícita** (casilla) antes de habilitar «Emitir nota de crédito».
6. Tras emitir: muestra `FC01-00000001`, estado *Pendiente*, y que se envía sola; la fila aparece en la lista. Errores del servicio tal cual (ya son claros).

### Estados que hay que cubrir
Emitiendo (botón bloqueado, evita doble clic: la base ya impide el duplicado, pero el usuario no debe ver un error por eso) · éxito · bloqueo por nota existente (con el número) · sin permiso · comprobante no aceptado · error inesperado.

### Riesgos de diseño a decidir antes de programar
1. **Estados puestos a mano.** `TaxDocumentList` hoy permite a quien puede gestionar cambiar el estado de un comprobante a mano (`SIGUIENTES`). Con eso se podría marcar «ACEPTADO» un comprobante que el proveedor nunca vio y habilitar una nota sobre él. Propuesta: para negocios reales, exigir `externalId` (confirmado por el proveedor) para ofrecer la nota, y valorar retirar la edición manual de estado para ellos. ⚠️ A decidir.
2. **Qué hace «anular» con el stock y la caja**: hoy nada. El aviso lo dice. Si el negocio espera que la nota reponga stock, es otra fase.
3. **Ticket/PDF de la nota**: la representación impresa de la nota no existe; el ticket actual solo cubre venta/boleta/factura. Fuera de esta pantalla.
4. **Notas de débito y parciales**: no aparecen (1A.3b).

### Pruebas previstas (cuando se programe)
Acción de servidor: sin permiso, con otro negocio y sin sesión; render del modal en cada estado (react-dom/server, como los tickets);
prueba estructural de que el componente cliente no importa el cliente base de Prisma; y el botón oculto/desactivado según las reglas.
