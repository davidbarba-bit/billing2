-- v18: política de emisión para setup y baja.
--
-- Modo por defecto = 'next_cycle' (backward compat). Cuando se cambia a
-- 'immediate', el cargo se emite en una invoice independiente al instalar
-- (POST /api/v1/units) o al dar de baja (PATCH /api/v1/units/:id con
-- active_to). El cycle invoice del periodo deja de incluir ese cargo porque
-- el flag setupBilledAt/removalBilledAt queda seteado al emitir.

ALTER TABLE "services" ADD COLUMN "setup_billing_mode"   TEXT NOT NULL DEFAULT 'next_cycle';
ALTER TABLE "services" ADD COLUMN "removal_billing_mode" TEXT NOT NULL DEFAULT 'next_cycle';
