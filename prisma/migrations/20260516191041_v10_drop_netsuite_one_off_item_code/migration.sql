-- v10: elimina netsuite_one_off_item_code.
-- Un service one_off (prepago) genera 2 fees al facturar una unit:
--   - kind=setup  → mapea a netsuite_setup_item_code
--   - kind=one_off (N mensualidades por adelantado) → mapea a
--                   netsuite_monthly_item_code (es la misma "renta mensual"
--                   conceptual, solo que se cobra anticipada).
-- Tener un código aparte para one_off era redundante.

ALTER TABLE "services" DROP COLUMN "netsuite_one_off_item_code";
