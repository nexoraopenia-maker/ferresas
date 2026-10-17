# Cómo medir el TTFB desde Lima

El TTFB que importa es el tuyo, con tu sesión y tu red. Yo no puedo medirlo:
mi red a Vercel son ~350 ms y mi red a Neon oscila entre 150 y 605 ms, así que
cualquier número que dé desde aquí dice más de mi conexión que del sistema.

Esto se mide en un minuto, con sesión real, sin instalar nada.

## Opción A — Pestaña de red del navegador (la más rápida)

1. Entra al panel y haz login.
2. Abre las herramientas de desarrollo (`F12` o `Cmd+Opt+I`) → pestaña **Red**.
3. Marca **Deshabilitar caché**.
4. Navega entre `/pos`, `/inventario`, `/cotizaciones`, `/comprobantes` y
   `/facturacion`.
5. Pincha cada petición del documento → **Tiempos**. Ahí sale el TTFB
   («Esperando respuesta del servidor»).
6. En la misma petición, pestaña **Cabeceras** → busca `server-timing`:

```
server-timing: jwt;dur=2, sesion_bd;dur=131, proxy_total;dur=133, region;desc="gru1"
```

- `sesion_bd` — lo que tarda el proxy en consultar la sesión. **Es el número
  clave:** si sale por encima de 100 ms, confirma que el proxy corre lejos de
  la base (ver docs/REGIONES.md).
- `region` — dónde corrió el proxy para TI.

**En frío frente a en caliente:** deja el panel quieto 10 minutos y vuelve a
navegar. Esa primera navegación incluye el despertar de Neon
(docs/NEON-ARRANQUE-FRIO.md).

## Opción B — Desde la terminal, con tu cookie

Para tener números repetibles.

1. En **Red**, clic derecho sobre la petición del documento → *Copiar* →
   **Copiar como cURL**.
2. Pégalo en la terminal y añade al final:

```
-o /dev/null -w '\nTTFB: %{time_starttransfer}s  total: %{time_total}s\n' -D -
```

3. Repítelo 4-5 veces por ruta. La primera suele ser más lenta.

## Lo que ya está medido desde dentro de producción

```
npx tsx -e "1" >/dev/null   # (solo para fijar el contexto)
curl -s "https://ferresas.vercel.app/api/diagnostics/perf?key=TU_CRON_SECRET" | python3 -m json.tool
```

Eso devuelve el desglose por fases **medido dentro de producción**, así que no
depende de desde dónde lo llames. Es lo que separa «el servidor tardó» de «la
red tardó».

## Qué deberías ver tras los cambios de hoy

| | esperado |
|---|---|
| Respuesta visual al clic | **< 100 ms** — el menú se marca y sale el esqueleto, sin esperar al servidor |
| `sesion_bd` en caliente | ⚠️ ~120-140 ms *si el proxy corre en gru1* — es lo que queda por arreglar |
| Fases de la página | 3-16 ms (medido en `cle1`) |
| Primera navegación tras una pausa | + ~400 ms del despertar de Neon |

Si la respuesta visual **no** es inmediata, eso sí es un defecto: dímelo con
la ruta y lo que viste, porque no depende de la red.
