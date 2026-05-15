-- v7: cambios de precio programados a vigencia desde el siguiente ciclo.
-- Se aplican cuando periodStart >= pending_effective_from. Las tres columnas
-- viven o nulas (sin cambio programado) o todas pobladas (cambio pendiente).

-- AlterTable
ALTER TABLE "services" ADD COLUMN     "pending_monthly_unit_amount_cents" INTEGER,
                       ADD COLUMN     "pending_setup_unit_amount_cents" INTEGER,
                       ADD COLUMN     "pending_effective_from" TIMESTAMP(3);
