-- CreateTable
CREATE TABLE "catalog_events" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "default_amount_cents" INTEGER,
    "netsuite_item_code" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "catalog_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_event_occurrences" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "catalog_event_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "unit_external_id" TEXT,
    "amount_cents" INTEGER NOT NULL,
    "billing_mode" TEXT NOT NULL,
    "reference" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "fee_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_event_occurrences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "catalog_events_organization_id_code_key" ON "catalog_events"("organization_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_event_occurrences_fee_id_key" ON "catalog_event_occurrences"("fee_id");

-- CreateIndex
CREATE INDEX "catalog_event_occurrences_organization_id_customer_id_billing_mode_idx" ON "catalog_event_occurrences"("organization_id", "customer_id", "billing_mode");

-- AddForeignKey
ALTER TABLE "catalog_events" ADD CONSTRAINT "catalog_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_event_occurrences" ADD CONSTRAINT "catalog_event_occurrences_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_event_occurrences" ADD CONSTRAINT "catalog_event_occurrences_catalog_event_id_fkey" FOREIGN KEY ("catalog_event_id") REFERENCES "catalog_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_event_occurrences" ADD CONSTRAINT "catalog_event_occurrences_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_event_occurrences" ADD CONSTRAINT "catalog_event_occurrences_fee_id_fkey" FOREIGN KEY ("fee_id") REFERENCES "fees"("id") ON DELETE SET NULL ON UPDATE CASCADE;
