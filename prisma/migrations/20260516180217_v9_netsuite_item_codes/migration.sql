-- v9: códigos de producto NetSuite por entidad fuente de fees.
-- Cada Fee guarda el item_code resuelto al emitir la invoice (snapshot
-- inmutable) para que cambios futuros de configuración no afecten invoices
-- ya facturadas.
--
-- En Service hay 3 códigos posibles porque un mismo Service puede generar
-- fees de distinto kind (monthly/setup/one_off) — cada uno mapea a un item
-- distinto en el catálogo de NetSuite.

ALTER TABLE "services"
  ADD COLUMN "netsuite_monthly_item_code" TEXT,
  ADD COLUMN "netsuite_setup_item_code" TEXT,
  ADD COLUMN "netsuite_one_off_item_code" TEXT;

ALTER TABLE "service_add_ons"
  ADD COLUMN "netsuite_item_code" TEXT;

ALTER TABLE "customer_add_ons"
  ADD COLUMN "netsuite_item_code" TEXT;

ALTER TABLE "fees"
  ADD COLUMN "netsuite_item_code" TEXT;
