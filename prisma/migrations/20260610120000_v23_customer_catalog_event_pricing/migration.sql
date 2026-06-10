-- v23: pricing por cliente para eventos del catálogo facturables.
--
-- Antes: POST /api/v1/catalog-events/occurrences aceptaba amount_cents y
-- billing_mode en el request body. Eso no escala cuando cada cliente tiene
-- precios pactados distintos para el mismo evento (revisión, capacitación).
--
-- Ahora: el monto y el billing_mode viven en customer_catalog_event_pricing
-- por (customer, catalog_event). El handler lee de aquí; el dev integrador
-- solo envía el código del evento + customer external_id. Si no hay pricing
-- configurado, el POST de la ocurrencia falla con
-- `customer_catalog_event_pricing_not_set`.

-- 1. Default billing mode a nivel catálogo (semilla para nuevos pricings).
ALTER TABLE "catalog_events"
  ADD COLUMN "default_billing_mode" TEXT NOT NULL DEFAULT 'next_cycle';

-- 2. Tabla de pricing por cliente.
CREATE TABLE "customer_catalog_event_pricing" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "customer_id" TEXT NOT NULL,
  "catalog_event_id" TEXT NOT NULL,
  "amount_cents" INTEGER NOT NULL,
  "billing_mode" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "customer_catalog_event_pricing_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "customer_catalog_event_pricing_customer_id_catalog_event_id_key"
  ON "customer_catalog_event_pricing"("customer_id", "catalog_event_id");

CREATE INDEX "customer_catalog_event_pricing_organization_id_idx"
  ON "customer_catalog_event_pricing"("organization_id");

ALTER TABLE "customer_catalog_event_pricing"
  ADD CONSTRAINT "customer_catalog_event_pricing_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "customer_catalog_event_pricing"
  ADD CONSTRAINT "customer_catalog_event_pricing_customer_id_fkey"
  FOREIGN KEY ("customer_id") REFERENCES "customers"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "customer_catalog_event_pricing"
  ADD CONSTRAINT "customer_catalog_event_pricing_catalog_event_id_fkey"
  FOREIGN KEY ("catalog_event_id") REFERENCES "catalog_events"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- 3. Backfill — preserva continuidad para ocurrencias futuras. Por cada par
-- (customer activo × catalog_event activo) en la misma org, donde el catálogo
-- tenga default_amount_cents, creamos pricing con ese default. Las
-- combinaciones sin default se omiten — el admin debe configurarlas antes de
-- registrar ocurrencias.
INSERT INTO "customer_catalog_event_pricing"
  (id, organization_id, customer_id, catalog_event_id, amount_cents, billing_mode, created_at, updated_at)
SELECT
  gen_random_uuid()::text,
  c.organization_id,
  c.id,
  ce.id,
  ce.default_amount_cents,
  'next_cycle',
  NOW(),
  NOW()
FROM "customers" c
JOIN "catalog_events" ce ON ce.organization_id = c.organization_id
WHERE ce.default_amount_cents IS NOT NULL
  AND ce.active = TRUE
  AND c.status != 'terminated';
