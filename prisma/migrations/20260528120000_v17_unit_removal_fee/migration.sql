-- v17: cobro de baja (desinstalación) por unit.
--
-- Espejo del setup fee pero disparado al terminar la unit (activeTo != null).
-- Se cobra una sola vez en el invoice del period que contiene la baja.
-- Default 0 = sin cargo de baja (backward compatible). Solo se aplica a
-- pricing_model=recurring; one_off ignora el campo.
--
-- En migración de plan, el endpoint pone removal_billed_at = migration_at en
-- la unit vieja para neutralizar el cargo (es transferencia, no baja real).

ALTER TABLE "services" ADD COLUMN "removal_unit_amount_cents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "services" ADD COLUMN "netsuite_removal_item_code" TEXT;

ALTER TABLE "units" ADD COLUMN "removal_billed_at" TIMESTAMP(3);
