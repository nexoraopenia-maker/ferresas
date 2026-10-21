# Contrato REST con el PSE

`providers/pse-rest.ts` habla este contrato. **Ningún PSE comercial (Nubefact,
ApisPeru, Factiliza…) lo implementa tal cual**: cada uno tiene su formato y su
autenticación. Conectar uno exige escribir un *perfil* que traduzca esto a su
API y probarlo en SU ambiente de pruebas. ⚠️ No hay ningún perfil escrito: no
hay contrato ni credenciales de pruebas, y no se inventa un formato ajeno de
memoria.

## Qué se configura (por negocio, solo el dueño)

- **URL base** (https, host público; validada contra SSRF).
- **Token**, cifrado con AES-256-GCM y atado al negocio. Clave maestra en
  `PSE_MASTER_KEY` (entorno). Opcional: `PSE_ALLOWED_HOSTS` para limitar los
  proveedores permitidos.

El PSE firma con SU certificado: el negocio no sube ningún `.pfx`.

## Peticiones

Todas con `Authorization: Bearer <token>`, `Accept: application/json`.

### Emitir — `POST {base}/comprobantes`

Cabecera `Idempotency-Key: <RUC>-<tipo>-<serie>-<correlativo>` (el PSE debe
devolver el mismo resultado ante una repetición).

```json
{
  "version": 1,
  "comprobante": { "...ComprobanteFiscal (ver providers/types.ts)": "..." },
  "xml_ubl_base64": "<UBL 2.1 sin firmar, base64>"
}
```

### Consultar — `GET {base}/comprobantes/{id | SERIE-CORRELATIVO}`
### Baja — `POST {base}/comprobantes/{id}/baja` con `{ "motivo": "..." }`
### Descargar — `GET {base}/comprobantes/{id}/descarga/{xml|cdr|pdf}`
→ `{ "contenido_base64", "nombre", "mime" }`
### Salud — `GET {base}/salud`
→ `{ "ok": true, "mensaje": "...", "certificado_vence_en": "2027-03-01" }`

## Respuesta de emitir / consultar

```json
{ "estado": "ACEPTADO | OBSERVADO | RECHAZADO | ENVIADO | PENDIENTE",
  "hash": "DigestValue de la firma",
  "codigo": "código de respuesta del CDR",
  "mensaje": "descripción del CDR",
  "ticket": "...", "id": "id del comprobante en el PSE" }
```

- `OBSERVADO` = aceptado con observaciones: es válido.
- `PENDIENTE` se guarda como `ENVIADO` (recibido, a la espera de respuesta).
- El `hash` solo se guarda si el comprobante queda `ACEPTADO` u `OBSERVADO`; es
  el que va en el QR del ticket.

## Cómo se interpretan los códigos HTTP

| Respuesta | Resultado en FerreSaaS |
|---|---|
| 2xx con cuerpo válido | el estado que diga el PSE |
| 2xx ilegible / estado desconocido | `PENDIENTE`, reintentable (nunca aceptado) |
| 401, 403 | error de **configuración**: el comprobante no cambia de estado |
| 408, 429, 5xx, red caída, timeout | `PENDIENTE`, reintentable |
| 3xx | `PENDIENTE`, reintentable (no se siguen redirecciones) |
| otro 4xx | `RECHAZADO` con el mensaje del PSE; reintentar no lo arregla |

Límites: 15 s de tiempo total, 1 MB de respuesta (8 MB en descargas).
