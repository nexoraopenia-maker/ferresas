-- Marca de revocación de sesiones JWT al cambiar la contraseña.
-- Nullable y sin valor por defecto: es aditiva, no reescribe ninguna fila y
-- las sesiones existentes siguen siendo válidas hasta que su dueño cambie la
-- contraseña por primera vez.
ALTER TABLE "users" ADD COLUMN "passwordChangedAt" TIMESTAMP(3);
