-- v22: razones sociales (entidades fiscales) por cliente.
-- La identidad fiscal se muda del Customer a TaxEntity. Esta migración:
--   1. Crea la tabla tax_entities.
--   2. Back-filla UNA razón social por cada customer existente (is_default=true)
--      desde sus datos fiscales actuales.
--   3. Agrega tax_entity_id (nullable) a services, customer_add_ons,
--      catalog_event_occurrences, invoices y los apunta al default del cliente.

-- CreateTable
CREATE TABLE "tax_entities" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "legal_name" TEXT NOT NULL,
    "tax_identification_number" TEXT,
    "tax_regime" TEXT,
    "cfdi_use" TEXT,
    "email" TEXT,
    "address_line1" TEXT,
    "address_line2" TEXT,
    "state" TEXT,
    "zipcode" TEXT,
    "city" TEXT,
    "country" TEXT,
    "netsuite_internal_id" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tax_entities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tax_entities_organization_id_customer_id_idx" ON "tax_entities"("organization_id", "customer_id");

-- AddForeignKey
ALTER TABLE "tax_entities" ADD CONSTRAINT "tax_entities_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tax_entities" ADD CONSTRAINT "tax_entities_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: una razón social default por cada customer, copiando sus datos
-- fiscales actuales. legal_name parte del nombre comercial (el admin lo refina).
INSERT INTO "tax_entities" (
    "id", "organization_id", "customer_id", "legal_name",
    "tax_identification_number", "address_line1", "address_line2",
    "state", "zipcode", "city", "country", "netsuite_internal_id",
    "is_default", "active", "created_at", "updated_at"
)
SELECT
    gen_random_uuid(), c."organization_id", c."id", c."name",
    c."tax_identification_number", c."address_line1", c."address_line2",
    c."state", c."zipcode", c."city", c."country", c."netsuite_internal_id",
    true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "customers" c;

-- AlterTable: agrega tax_entity_id (nullable) a las tablas facturables.
ALTER TABLE "services" ADD COLUMN "tax_entity_id" TEXT;
ALTER TABLE "customer_add_ons" ADD COLUMN "tax_entity_id" TEXT;
ALTER TABLE "catalog_event_occurrences" ADD COLUMN "tax_entity_id" TEXT;
ALTER TABLE "invoices" ADD COLUMN "tax_entity_id" TEXT;

-- AddForeignKey
ALTER TABLE "services" ADD CONSTRAINT "services_tax_entity_id_fkey" FOREIGN KEY ("tax_entity_id") REFERENCES "tax_entities"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "customer_add_ons" ADD CONSTRAINT "customer_add_ons_tax_entity_id_fkey" FOREIGN KEY ("tax_entity_id") REFERENCES "tax_entities"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "catalog_event_occurrences" ADD CONSTRAINT "catalog_event_occurrences_tax_entity_id_fkey" FOREIGN KEY ("tax_entity_id") REFERENCES "tax_entities"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tax_entity_id_fkey" FOREIGN KEY ("tax_entity_id") REFERENCES "tax_entities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: apunta cada fila al default tax entity de su customer.
UPDATE "services" s
SET "tax_entity_id" = te."id"
FROM "tax_entities" te
WHERE te."customer_id" = s."customer_id" AND te."is_default" = true;

UPDATE "customer_add_ons" a
SET "tax_entity_id" = te."id"
FROM "tax_entities" te
WHERE te."customer_id" = a."customer_id" AND te."is_default" = true;

UPDATE "catalog_event_occurrences" o
SET "tax_entity_id" = te."id"
FROM "tax_entities" te
WHERE te."customer_id" = o."customer_id" AND te."is_default" = true;

UPDATE "invoices" i
SET "tax_entity_id" = te."id"
FROM "tax_entities" te
WHERE te."customer_id" = i."customer_id" AND te."is_default" = true;
