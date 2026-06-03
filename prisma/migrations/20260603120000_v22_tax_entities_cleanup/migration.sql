-- v22 cleanup: la identidad fiscal vive 100% en tax_entities.
--   1. tax_entity_id pasa a NOT NULL en las 4 tablas facturables (back-fill
--      defensivo de cualquier fila NULL al default del cliente antes de forzar).
--   2. Se recrean los FKs sin ON DELETE SET NULL (incompatible con NOT NULL).
--   3. Se eliminan los campos fiscales duplicados del Customer.

-- 1. Back-fill defensivo (filas creadas entre la migración v22 inicial y este
--    deploy que pudieran tener tax_entity_id NULL).
UPDATE "services" s
SET "tax_entity_id" = te."id"
FROM "tax_entities" te
WHERE s."tax_entity_id" IS NULL AND te."customer_id" = s."customer_id" AND te."is_default" = true;

UPDATE "customer_add_ons" a
SET "tax_entity_id" = te."id"
FROM "tax_entities" te
WHERE a."tax_entity_id" IS NULL AND te."customer_id" = a."customer_id" AND te."is_default" = true;

UPDATE "catalog_event_occurrences" o
SET "tax_entity_id" = te."id"
FROM "tax_entities" te
WHERE o."tax_entity_id" IS NULL AND te."customer_id" = o."customer_id" AND te."is_default" = true;

UPDATE "invoices" i
SET "tax_entity_id" = te."id"
FROM "tax_entities" te
WHERE i."tax_entity_id" IS NULL AND te."customer_id" = i."customer_id" AND te."is_default" = true;

-- 2. Recrear FKs (drop SET NULL → re-add RESTRICT) y forzar NOT NULL.
ALTER TABLE "services" DROP CONSTRAINT "services_tax_entity_id_fkey";
ALTER TABLE "services" ALTER COLUMN "tax_entity_id" SET NOT NULL;
ALTER TABLE "services" ADD CONSTRAINT "services_tax_entity_id_fkey" FOREIGN KEY ("tax_entity_id") REFERENCES "tax_entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "customer_add_ons" DROP CONSTRAINT "customer_add_ons_tax_entity_id_fkey";
ALTER TABLE "customer_add_ons" ALTER COLUMN "tax_entity_id" SET NOT NULL;
ALTER TABLE "customer_add_ons" ADD CONSTRAINT "customer_add_ons_tax_entity_id_fkey" FOREIGN KEY ("tax_entity_id") REFERENCES "tax_entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "catalog_event_occurrences" DROP CONSTRAINT "catalog_event_occurrences_tax_entity_id_fkey";
ALTER TABLE "catalog_event_occurrences" ALTER COLUMN "tax_entity_id" SET NOT NULL;
ALTER TABLE "catalog_event_occurrences" ADD CONSTRAINT "catalog_event_occurrences_tax_entity_id_fkey" FOREIGN KEY ("tax_entity_id") REFERENCES "tax_entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "invoices" DROP CONSTRAINT "invoices_tax_entity_id_fkey";
ALTER TABLE "invoices" ALTER COLUMN "tax_entity_id" SET NOT NULL;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tax_entity_id_fkey" FOREIGN KEY ("tax_entity_id") REFERENCES "tax_entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 3. Eliminar campos fiscales duplicados del Customer (ahora viven en tax_entities).
ALTER TABLE "customers" DROP COLUMN "tax_identification_number";
ALTER TABLE "customers" DROP COLUMN "address_line1";
ALTER TABLE "customers" DROP COLUMN "address_line2";
ALTER TABLE "customers" DROP COLUMN "state";
ALTER TABLE "customers" DROP COLUMN "zipcode";
ALTER TABLE "customers" DROP COLUMN "city";
ALTER TABLE "customers" DROP COLUMN "country";
ALTER TABLE "customers" DROP COLUMN "netsuite_internal_id";
