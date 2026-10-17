# Región de las funciones

## El problema

Medido en producción con `/api/diagnostics/perf`:

```
región Vercel : iad1   (us-east-1, Washington D.C.)
host Neon     : ep-wandering-bread-ayy7p37j-pooler.c-5.us-east-2.aws.neon.tech
ping caliente : 11-16 ms
```

Las funciones corrían en **us-east-1** y la base está en **us-east-2**. Esos
11-16 ms son el trayecto entre ambas, y **se pagan una vez por consulta**. Una
pantalla del panel hace entre 4 y 6, así que son 50-90 ms de puro trayecto
antes de contar el trabajo real.

## El cambio

`vercel.json` fija `"regions": ["cle1"]`. Según la tabla de regiones de
Vercel, **`cle1` es `us-east-2` (Cleveland)**: la misma región de AWS donde
está el cómputo de Neon. El trayecto baja de ~14 ms a un dígito.

## Por qué esto NO aleja al usuario de Lima

Es la duda razonable: si la función se mueve a Cleveland, ¿no queda más lejos
de Lima que Washington?

En la práctica no, por cómo está montada la red de Vercel. Su documentación lo
describe así: los **PoP** (126 puntos de presencia) terminan el TCP y el TLS
cerca del usuario y encaminan la petición *por red privada* hasta la región de
cómputo más cercana, con latencia de un dígito. El usuario en Lima sigue
hablando con el PoP que le toca; lo que cambia es el último tramo, interno.

El canje, además, es asimétrico y favorable:

| | antes (iad1) | después (cle1) |
|---|---|---|
| Trayecto a la base, **por consulta** | ~14 ms | un dígito |
| Consultas por pantalla | 4-6 | 4-6 |
| Coste total del trayecto | **50-90 ms** | **~5-20 ms** |
| Trayecto del usuario | 1 vez | 1 vez, ~igual |

La distancia a la base se multiplica por el número de consultas; la del
usuario, no.

## Riesgo

Bajo. Si la región no estuviera disponible para el plan, **el build falla y
Vercel NO promueve el despliegue**: producción sigue sirviendo la versión
anterior. No hay ventana de caída.

`iad1` sigue siendo el P0 de failover de Vercel, y `cle1` su P1, así que
elegir `cle1` no sale del par de regiones mejor conectadas entre sí.

## Fuente

- [Vercel — Global network and regions](https://vercel.com/docs/edge-network/regions):
  tabla de regiones (`cle1` → `us-east-2`), el papel de los PoP y la
  recomendación explícita de ejecutar las funciones en la misma región que la
  base de datos.
