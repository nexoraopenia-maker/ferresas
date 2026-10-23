# Convención de migraciones

Las migraciones de Prisma solo avanzan. Para poder desplegar sin caídas y deshacer con
criterio, se sigue **expand / contract**:

1. **Expand** — se AÑADE lo nuevo sin romper lo viejo: columnas nulas o con valor por
   defecto, tablas e índices nuevos. El código viejo y el nuevo conviven. Estas
   migraciones **no necesitan `down.sql`**: deshacerlas es simplemente no usar lo añadido.
2. **Migrate** — si hay que mover datos, se hace en una migración de DATOS aparte.
3. **Contract** — se QUITA lo viejo (columna, tabla, restricción) solo cuando ningún
   código la usa ya. Es la parte destructiva.

## `down.sql`

Solo para migraciones **destructivas** (contract) o **de datos**: junto a `migration.sql`
va un `down.sql` que las deshace en lo que sea posible (y dice por escrito lo que NO se
puede recuperar, por ejemplo una columna borrada con datos). Prisma no lo ejecuta: es la
receta para revertir a mano, y debe haberse probado en un esquema temporal.

## Cómo se prepara una migración

1. Cambiar `prisma/schema.prisma`.
2. Generar el SQL con `prisma migrate diff --from-schema <antes> --to-schema prisma/schema.prisma --script`
   (nunca escrito a mano: una migración a mano con el nombre de tabla equivocado dejó
   producción en P3009).
3. Repetir TODAS las migraciones en un esquema temporal de staging y comprobar que no
   queda deriva (`No difference detected`).
4. Aplicar a staging con `prisma migrate deploy`. Producción lo aplica el build de Vercel.

## Nombres y orden

El nombre de cada carpeta empieza por una marca de tiempo, y Prisma ordena por ella. Se
comprobó en un esquema temporal (2026-10-22) que `prisma migrate deploy` **aplica** una
migración con marca anterior aunque ya haya otras posteriores aplicadas: no falla. Aun así,
**no se retrocede**: el orden de las carpetas es el orden en que se aplican en una base
NUEVA, y debe coincidir con el de producción. Regla: la marca de una migración nueva es
mayor que la de todas las existentes (la hora real, o un minuto después de la última si la
hora real quedara por detrás). Las ya aplicadas en algún entorno no se renombran nunca.
