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
| Correlativo inicial por serie | ✅ **PREGÚNTALO SIEMPRE** si ya emitía antes |

### 🔴 La pregunta que hay que hacerle a cada cliente

> **«¿Cuál fue el último número que emitiste en cada serie?»**
>
> Por ejemplo: «la última boleta fue B001-00004532 y la última factura
> F001-00000871».

Y hay que hacerla **ANTES de su primera venta**, no después.

**Por qué.** Un negocio que ya facturaba con otro sistema llega con sus series
avanzadas. Si FerreSaaS arranca en 1, emitirá números **ya usados** bajo su
RUC: comprobantes duplicados ante SUNAT, que solo se arreglan con notas de
crédito (que todavía no tenemos).

**Dónde se configura.** `/comprobantes` → panel «Series de \<sucursal\>» →
*Fijar inicio*. Se escribe el **primer número que emitirá**: si el último fue
el 4 532, aquí va **4533**.

**La restricción, y por qué es así.** El arranque solo se puede fijar
**mientras esa serie no haya emitido nada**. En cuanto sale el primer
comprobante queda bloqueado, porque moverlo después:

- **subirlo** deja un hueco en la numeración, y la norma exige correlativos
  sin huecos;
- **bajarlo** produce un número duplicado.

Ninguna de las dos se puede deshacer: el comprobante ya salió impreso y
declarado. La UI lo dice con el número concreto delante y exige marcar una
casilla de confirmación; el servidor lo vuelve a comprobar dentro de la
transacción y lo deja auditado (quién, cuándo, valor anterior y nuevo).

**Si el cliente no sabe su último número:** que lo mire en su sistema anterior
o en el portal de SUNAT antes de vender. Arrancar en 1 «por ahora» no es una
opción recuperable.

---

## Resumen para el formulario de alta

**Imprescindible para emitir:**
1. RUC + razón social exacta
2. Domicilio fiscal con ubigeo
3. Certificado digital + su clave
4. Usuario SOL **secundario** + clave
5. Por sucursal: código de establecimiento, dirección y ubigeo
6. **Correlativo inicial por serie**, si ya facturaba antes — y antes de su
   primera venta, porque después queda bloqueado

**Lo que FerreSaaS debe hacer con eso:**
- Cifrar en reposo: certificado, su clave, la Clave SOL y las del proveedor.
- Verificar las credenciales **en el alta** (`verificarCredenciales` ya existe
  en la interfaz), no en la primera venta con un cliente esperando.
- Avisar del vencimiento del certificado con antelación.
- Emitir primero en el **entorno de pruebas** del proveedor y solo pasar a
  producción cuando salga un comprobante aceptado.

**Lo que falta en el esquema** (una migración, no urgente hasta contratar):
- ~~`Tenant.ubigeo`~~ ✅ añadido
- Tabla de credenciales fiscales por tenant, **cifradas**
- ~~correlativo inicial configurable~~ ✅ `DocumentCounter.startNumber`
