# Arranque en frío de Neon: tres opciones

## Lo medido

Con `/api/diagnostics/perf` en producción:

```
arranque Neon : 369 ms   (primera consulta tras inactividad)
ping caliente :  11 ms
¿suspendido?  : true
```

Otras lecturas del mismo endpoint: **82 ms, 119 ms, 696 ms**. Es decir, el
despertar cuesta entre **~70 ms y ~700 ms** y el ping en caliente **11-16 ms**.

El cómputo se suspende solo (*scale to zero*) y la **primera** navegación tras
un rato sin usar el panel paga ese despertar. Para quien está en el mostrador,
eso es "el sistema va lento al entrar" seguido de "ahora va bien" — que es
exactamente el patrón que se percibe como poco fiable.

## ⚠️ La configuración actual: no la puedo leer

Se lee desde el panel de Neon, y para consultarla por API haría falta un token
que no tengo (y que no te voy a pedir).

**Dónde mirar:** panel de Neon → tu proyecto → *Branches* → la rama de
producción (`ep-wandering-bread-ayy7p37j`) → *Compute* → **Scale to zero**.
Ahí sale el tiempo de inactividad y si se puede desactivar, que depende del
plan.

El comportamiento observado —suspende y despierta en cientos de milisegundos—
es compatible con el ajuste por defecto. En el plan **Free** son 5 minutos y
**no se puede cambiar**; en **Launch** sí se puede desactivar; en **Scale** es
configurable entre 1 minuto y siempre encendido.

---

## Opción 1 — Desactivar el scale-to-zero

El cómputo nunca se suspende.

| | |
|---|---|
| Efecto | **El arranque en frío desaparece.** Siempre 11-16 ms |
| Requisito | Plan **Launch** o superior. En Free no se puede |
| Costo | ⚠️ ~**$0.106/CU-hora** en Launch. Con 0.25 CU × 730 h ≈ **$19/mes**; con 0.5 CU ≈ **$38/mes** |
| Riesgo | Ninguno técnico. Pagas 730 h al mes aunque nadie entre de noche |

## Opción 2 — Subir el tiempo de inactividad

En vez de 5 minutos, por ejemplo 1 hora.

| | |
|---|---|
| Efecto | **Mitiga, no elimina.** Dentro de la jornada casi nunca se suspende; la primera entrada del día sigue pagando el despertar |
| Requisito | Plan **Scale** para llegar a valores altos |
| Costo | Entre la 1 y la 3. Pagas las horas en que hubo actividad reciente, no las 730 |
| Riesgo | Difícil de calibrar: una ferretería con poco movimiento a media tarde puede seguir suspendiendo |

## Opción 3 — Un cron que haga ping en horario comercial

Mantenerlo despierto a propósito de 8:00 a 21:00 (Lima).

| | |
|---|---|
| Efecto | Equivale a la 1 **dentro del horario**, y fuera deja suspender |
| Requisito | Ninguno de plan. Vercel Cron ya está en uso para `expire-trials` |
| Costo | ⚠️ 13 h/día × 30 ≈ **390 h/mes** en lugar de 730. Con 0.25 CU ≈ **$10/mes**; con 0.5 CU ≈ **$20/mes**. Los crons de Vercel no cuestan aparte en los planes con ellos incluidos |
| Riesgo | **Es un apaño, y conviene decirlo.** Un ping cada 4 min son ~195 invocaciones al día. Si el cron falla o cambias el horario, el arranque en frío vuelve sin que nadie se entere. Y el cron mínimo de Vercel en Hobby es **diario**, no cada minuto: con Hobby esta opción **no funciona** |

---

## Recomendación: **opción 1**, desactivar el scale-to-zero

Tres razones:

**1. El ahorro no compensa la molestia.** La diferencia entre la 1 y la 3 son
~$9-18/mes. Es menos de lo que cuesta una hora de soporte explicándole a un
cliente por qué "el sistema va lento a veces".

**2. La opción 3 es frágil por diseño.** Mantener algo despierto con pings es
luchar contra el comportamiento del producto, y falla en silencio. El día que
el cron se rompa, el síntoma será exactamente el de hoy y nadie lo relacionará
con un cron.

**3. El arranque en frío es tu peor momento de uso.** Lo paga el *primer* clic
del día y después de cada pausa — justo cuando el cajero vuelve al mostrador
con un cliente delante. Es el que más se recuerda.

**Cuándo reconsiderar:** si la factura de cómputo pasa a ser una parte
apreciable del costo del SaaS, la 2 con un valor alto (30-60 min) da casi lo
mismo por menos.

### Lo que necesito de ti

1. **Qué plan de Neon tienes.** En Free la 1 no es posible y la 3 tampoco
   (cron diario en Hobby), así que la única vía sería subir de plan.
2. **Cuántas CU tiene configurada la rama de producción.** De eso depende si
   el costo es $19 o $38.

---

## Fuentes

Precios de terceros, no de la página oficial de Neon: ⚠️ **confírmalos antes
de decidir.**

- [Neon plans — documentación oficial](https://neon.com/docs/introduction/plans) — qué plan permite desactivar el scale-to-zero y los 5 min fijos del Free
- [Neon Pricing Calculator (2026)](https://makerkit.dev/pricing-calculator/neon) — $0.106/CU-hora en Launch
- [Neon Pricing 2026: The Real Serverless Postgres Bill](https://www.budgetforge.dev/tools/neon-pricing-2026)
- [Compute never truly scales to zero despite auto-suspend](https://github.com/neondatabase/neon/discussions/12900) — informe de un usuario: ~$19/mes en un proyecto de poco tráfico que no llegaba a suspender
