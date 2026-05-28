-- v19: split de cycle invoice en recurrentes vs únicos.
--
-- 'unified' (default) → backward compat: 1 invoice con todo.
-- 'split_by_kind'     → hasta 2 invoices al cierre del ciclo, divididas por
--                       naturaleza del concepto:
--                       · Recurrentes: monthly, service_addon, customer_addon,
--                         one_off (mensualidades prepagadas SON renta).
--                       · Únicos: setup, removal.
--
-- La separación es estrictamente del cycle invoice. Los flujos immediate
-- (v18, one_off_immediate, setup_immediate, removal_immediate) no cambian.

ALTER TABLE "customers" ADD COLUMN "cycle_invoice_mode" TEXT NOT NULL DEFAULT 'unified';
