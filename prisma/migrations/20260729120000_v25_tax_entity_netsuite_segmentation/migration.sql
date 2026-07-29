-- v25: segmentación contable de NetSuite por razón social.
--
-- Las Ubicaciones de NetSuite están amarradas a la subsidiaria, y cada razón
-- social corresponde a un customer de NetSuite en una subsidiaria concreta —
-- así que Location/Department/Class se definen aquí, con fallback a los
-- valores globales de organization.netsuite_config.
ALTER TABLE "tax_entities"
  ADD COLUMN "netsuite_location_id" TEXT,
  ADD COLUMN "netsuite_department_id" TEXT,
  ADD COLUMN "netsuite_class_id" TEXT;
