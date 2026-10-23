# Catálogo de ubigeo (INEI)

Aquí va el fichero **oficial** de «Códigos de Ubicación Geográfica» del INEI, en CSV
(o JSON). No se versiona un catálogo de terceros: ver `docs/COMPLIANCE.md` §3.

## Cómo cargarlo

```bash
npx tsx scripts/cargar-ubigeo.ts prisma/data/<fichero>.csv \
  --departamentos-fuente 25 --provincias-fuente <N> --distritos-fuente <N> \
  --fuente "INEI, Códigos de Ubicación Geográfica, <fecha o versión>" --version <año>
```

Los **tres totales** son las cifras que declara la fuente oficial (no las de tu
fichero). Son obligatorios: sin ellos no se carga nada. El cargador:

- exige que coincidan EXACTAMENTE con lo que trae el fichero;
- exige los 25 códigos de primer nivel, con **Callao = 07** y Lima = 15 (la señal de
  que es la codificación INEI y no la de RENIEC);
- rechaza duplicados, códigos que no sean de 6 dígitos y entradas huérfanas;
- **no escribe nada** si cualquier comprobación falla, y escribe todo o nada en una
  transacción.

Apunta a staging con `.env.local` (el cargador pasa por la guarda de entorno).
Para producción, el mismo comando con el entorno de producción, deliberadamente.
