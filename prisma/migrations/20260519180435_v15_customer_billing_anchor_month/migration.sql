-- v15: mes ancla del ciclo de facturación.
--
-- Para clientes con billing_period_months > 1 (trimestral, semestral, anual),
-- permite alinear los ciclos a un mes calendario específico. Si NULL, el
-- motor mantiene el comportamiento legacy (anclado al mes de subscription_at).
--
-- Ejemplo: trimestral con anchor_month=1 → ciclos Ene-Mar/Abr-Jun/Jul-Sep/Oct-Dic
-- (independiente de cuándo se creó el cliente).

ALTER TABLE "customers" ADD COLUMN "billing_anchor_month" INTEGER;
