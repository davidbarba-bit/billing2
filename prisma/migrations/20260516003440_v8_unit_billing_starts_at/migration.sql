-- v8: separa "cuándo empieza a reportar la unit" (active_from) de "cuándo
-- empieza a facturarse" (billing_starts_at). Útil para migración desde otras
-- plataformas: la unit empieza a reportar mid-mes pero su facturación se
-- ancla al inicio del mes (cobro full) o al inicio del próximo mes (skip).
-- Si está NULL, el motor cae al comportamiento default = activeFrom.

-- AlterTable
ALTER TABLE "units" ADD COLUMN "billing_starts_at" TIMESTAMP(3);
