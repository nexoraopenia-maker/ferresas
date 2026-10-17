# Qué pedirle a cada cliente para que pueda facturar

Lista de lo que hay que recolectar por **cada ferretería** antes de que pueda
emitir comprobantes válidos, con la vía **PSE/OSE** ya decidida.

> ⚠️ El detalle exacto **depende del proveedor que contrates**. Esta lista
> cubre lo que piden todos los PSE/OSE según la documentación consultada;
> confírmala contra el contrato antes de construir el formulario de alta.

---

## 1. Datos del negocio (sin fricción, se piden al registrarse)

| Dato | Dónde está hoy | Obligatorio |
|---|---|---|
| RUC (11 dígitos) | `Tenant.taxId` ✅ | **Sí** |
| Razón social exacta, como figura en el RUC | `Tenant.legalName` ✅ | **Sí** |
| Nombre comercial | `Tenant.name` ✅ | No |
| Dirección del domicilio fiscal | `Tenant.address` ✅ | **Sí** |
| Ubigeo del domicilio fiscal | `Tenant.ubigeo` ⚠️ falta en Tenant | **Sí** |
| Dirección y ubigeo de cada establecimiento | `Branch.address` / `Branch.ubigeo` ✅ | **Sí** |
| Código de establecimiento anexo | `Branch.establishmentCode` ✅ | **Sí** |

> **Falta:** `Tenant` no tiene columna `ubigeo`. El domicilio fiscal del
> emisor va en el XML, así que hace falta. Es una migración de una columna.

---

## 2. Certificado digital tributario

Lo que firma el comprobante. Sin él no hay emisión.

| Dato | Formato | Nota |
|---|---|---|
| Archivo del certificado | `.pfx` o `.p12` | Lo emite una entidad de certificación acreditada |
| Clave del certificado | texto | **Secreto.** Va cifrado |
| Fecha de vencimiento | fecha | Hay que **avisar antes** de que caduque |

**Lo que hay que decidirle al cliente:** ¿lo custodia el PSE o lo custodiamos
nosotros? Muchos PSE lo guardan ellos, y eso **quita de encima el problema más
delicado** de todo este asunto. Si lo custodiamos nosotros, va cifrado por
tenant con una clave que no esté en la base.

⚠️ **Un certificado caducado para la emisión en seco.** El sistema tiene que
avisar con semanas de antelación, no el día que falla una venta.

---

## 3. Credenciales de SUNAT

| Dato | Para qué | Riesgo |
|---|---|---|
| **Usuario SOL secundario** | Designar al PSE y consultar el buzón | Medio |
| **Clave del usuario secundario** | ídem | **Secreto** |

🔴 **Regla: NUNCA el usuario SOL principal.** El principal da acceso total al
buzón tributario del contribuyente: declaraciones, deudas, fraccionamientos.
SUNAT permite crear **usuarios secundarios** con permisos limitados, y es lo
único que hay que pedir. Pedir el principal sería pedir las llaves de la casa
para entregar una carta — y nos haría responsables de un acceso que no
necesitamos.

**Hay que escribir la instrucción de cómo crearlo** (SUNAT Operaciones en
Línea → Usuarios secundarios → asignar solo los perfiles de comprobantes
electrónicos). Sin esa guía, el cliente mandará el principal.

---

## 4. Credenciales del proveedor

| Dato | Nota |
|---|---|
| Usuario / token de API | Lo da el PSE al contratar |
| Clave / secreto | **Secreto** |
| Entorno | pruebas o producción |

Cómo se reparte depende del contrato: si **tú** contratas al PSE, son tus
credenciales y el cliente no ve nada; si cada cliente contrata por su cuenta,
son suyas y hay que guardarlas por tenant. **Lo primero es mucho mejor
producto** — el ferretero no debería tratar con un PSE.

---

## 5. Series autorizadas

| Dato | Nota |
|---|---|
| Series de factura (F001…) | Hoy se derivan de `Branch.seriesNumber` ✅ |
| Series de boleta (B001…) | ídem ✅ |
| Correlativo inicial | ⚠️ **si el cliente ya emitía antes** |

⚠️ **El caso que puede doler:** un cliente que YA facturaba con otro sistema
llega con la serie B001 en el correlativo 4 532. Si FerreSaaS arranca en 1,
emitirá números **ya usados** bajo su RUC. `DocumentCounter.next` permite
fijar el arranque, pero **no hay UI para hacerlo** y nadie lo recordará en el
alta. Hace falta un campo «correlativo inicial» en el onboarding.

---

## Resumen para el formulario de alta

**Imprescindible para emitir:**
1. RUC + razón social exacta
2. Domicilio fiscal con ubigeo
3. Certificado digital + su clave
4. Usuario SOL **secundario** + clave
5. Por sucursal: código de establecimiento, dirección y ubigeo
6. Correlativo inicial por serie, si ya facturaba antes

**Lo que FerreSaaS debe hacer con eso:**
- Cifrar en reposo: certificado, su clave, la Clave SOL y las del proveedor.
- Verificar las credenciales **en el alta** (`verificarCredenciales` ya existe
  en la interfaz), no en la primera venta con un cliente esperando.
- Avisar del vencimiento del certificado con antelación.
- Emitir primero en el **entorno de pruebas** del proveedor y solo pasar a
  producción cuando salga un comprobante aceptado.

**Lo que falta en el esquema** (una migración, no urgente hasta contratar):
- `Tenant.ubigeo`
- Tabla de credenciales fiscales por tenant, cifradas
- `Branch` o `DocumentCounter`: correlativo inicial configurable en el alta
