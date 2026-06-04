-- v22 fase 5: cada razón social tiene su propio external_id (handle estable
-- para NetSuite). NetSuite ve cada razón social como un customer separado.

ALTER TABLE "tax_entities" ADD COLUMN "external_id" TEXT;

-- Back-fill: la razón social default copia el external_id del cliente
-- (continuidad: customers que ya estaban sincronizados con NetSuite por su
-- external_id siguen mapeando a la misma entity).
UPDATE "tax_entities" te
SET "external_id" = c."external_id"
FROM "customers" c
WHERE c."id" = te."customer_id" AND te."is_default" = true;

-- Back-fill: razones sociales adicionales (no-default) — generan un sufijo
-- numérico por (customer, orden de creación). Ej. cust-1-2, cust-1-3...
-- Este caso solo existe en datos de pruebas; el form admin captura el
-- external_id explícitamente para las que se creen a partir de ahora.
WITH ranked AS (
  SELECT "id", "customer_id",
    ROW_NUMBER() OVER (PARTITION BY "customer_id" ORDER BY "created_at") + 1 AS rn
  FROM "tax_entities"
  WHERE "is_default" = false
)
UPDATE "tax_entities" te
SET "external_id" = c."external_id" || '-' || ranked."rn"::text
FROM "ranked", "customers" c
WHERE te."id" = ranked."id" AND c."id" = te."customer_id";

ALTER TABLE "tax_entities" ALTER COLUMN "external_id" SET NOT NULL;

CREATE UNIQUE INDEX "tax_entities_organization_id_external_id_key"
  ON "tax_entities"("organization_id", "external_id");
