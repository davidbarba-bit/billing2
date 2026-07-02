-- v24: config extra para el dispatch de factura estándar de NetSuite.
--
-- Bag JSON en la organización para guardar la configuración específica de la
-- cuenta NetSuite (subsidiaria, modo de referencia de entity/item, mapeo de
-- moneda a internal id, department/location opcionales). Se usa un JSON en
-- lugar de columnas explícitas para poder iterar contra el sandbox sin
-- migraciones nuevas cada vez que descubramos un campo requerido.
ALTER TABLE "organizations"
  ADD COLUMN "netsuite_config" JSONB NOT NULL DEFAULT '{}'::jsonb;
