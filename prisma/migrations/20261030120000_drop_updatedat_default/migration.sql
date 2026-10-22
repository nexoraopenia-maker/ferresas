-- Prisma gestiona `updatedAt` desde el cliente (@updatedAt) y no deja DEFAULT en la
-- base. Estas cuatro tablas lo traían de migraciones escritas a mano.
ALTER TABLE "branch_transfers" ALTER COLUMN "updatedAt" DROP DEFAULT;
ALTER TABLE "branches" ALTER COLUMN "updatedAt" DROP DEFAULT;
ALTER TABLE "cash_sessions" ALTER COLUMN "updatedAt" DROP DEFAULT;
ALTER TABLE "mermas" ALTER COLUMN "updatedAt" DROP DEFAULT;
