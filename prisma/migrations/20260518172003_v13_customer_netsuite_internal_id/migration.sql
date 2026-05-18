-- v13: cache del internal ID que NetSuite asigna al customer.
--
-- Contrato con NetSuite: customer.external_id de mini-Lago se usa como
-- externalId en NetSuite (referencia estable controlada por nosotros).
-- Adicionalmente, cuando NetSuite responde con su internal id al crear el
-- record, lo persistimos acá. Esto permite que el payload de dispatch
-- referencie al customer por internal id (faster path en NetSuite) o caiga
-- a "eid:<external_id>" como fallback si no se conoce todavía.

ALTER TABLE "customers" ADD COLUMN "netsuite_internal_id" TEXT;
