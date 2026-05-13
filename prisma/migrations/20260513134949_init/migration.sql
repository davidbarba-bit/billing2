-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "api_key" TEXT NOT NULL,
    "netsuite_account_id" TEXT,
    "netsuite_consumer_key" TEXT,
    "netsuite_consumer_secret" TEXT,
    "netsuite_token_key" TEXT,
    "netsuite_token_secret" TEXT,
    "netsuite_rest_base" TEXT,
    "netsuite_callback_secret" TEXT,
    "customer_counter" INTEGER NOT NULL DEFAULT 0,
    "invoice_counter" INTEGER NOT NULL DEFAULT 0,
    "credit_note_counter" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "sequential_id" INTEGER NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "firstname" TEXT,
    "lastname" TEXT,
    "customer_type" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "url" TEXT,
    "logo_url" TEXT,
    "legal_name" TEXT,
    "legal_number" TEXT,
    "tax_identification_number" TEXT,
    "address_line1" TEXT,
    "address_line2" TEXT,
    "state" TEXT,
    "zipcode" TEXT,
    "city" TEXT,
    "country" TEXT,
    "currency" TEXT NOT NULL,
    "timezone" TEXT,
    "net_payment_term" INTEGER,
    "external_salesforce_id" TEXT,
    "finalize_zero_amount_invoice" TEXT NOT NULL DEFAULT 'inherit',
    "shipping_address_line1" TEXT,
    "shipping_address_line2" TEXT,
    "shipping_city" TEXT,
    "shipping_zipcode" TEXT,
    "shipping_state" TEXT,
    "shipping_country" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "taxes" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "rate" DECIMAL(10,4) NOT NULL,
    "applied_to_organization" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "taxes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_tax_links" (
    "customer_id" TEXT NOT NULL,
    "tax_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_tax_links_pkey" PRIMARY KEY ("customer_id","tax_id")
);

-- CreateTable
CREATE TABLE "billable_metrics" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "aggregation_type" TEXT NOT NULL,
    "field_name" TEXT,
    "recurring" BOOLEAN NOT NULL DEFAULT false,
    "weighted_interval" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billable_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plans" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "invoice_display_name" TEXT,
    "interval" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL DEFAULT 0,
    "amount_currency" TEXT NOT NULL,
    "trial_period" DECIMAL(10,4),
    "pay_in_advance" BOOLEAN NOT NULL DEFAULT false,
    "bill_charges_monthly" BOOLEAN,
    "parent_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "charges" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "billable_metric_id" TEXT NOT NULL,
    "charge_model" TEXT NOT NULL DEFAULT 'standard',
    "invoice_display_name" TEXT,
    "invoiceable" BOOLEAN NOT NULL DEFAULT true,
    "pay_in_advance" BOOLEAN NOT NULL DEFAULT false,
    "prorated" BOOLEAN NOT NULL DEFAULT false,
    "min_amount_cents" INTEGER NOT NULL DEFAULT 0,
    "properties" JSONB NOT NULL DEFAULT '{}',
    "regroup_paid_fees" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "charges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "name" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "billing_time" TEXT NOT NULL DEFAULT 'calendar',
    "subscription_at" TIMESTAMP(3) NOT NULL,
    "started_at" TIMESTAMP(3),
    "ending_at" TIMESTAMP(3),
    "trial_ended_at" TIMESTAMP(3),
    "terminated_at" TIMESTAMP(3),
    "canceled_at" TIMESTAMP(3),
    "previous_plan_code" TEXT,
    "next_plan_code" TEXT,
    "downgrade_plan_date" TIMESTAMP(3),
    "current_billing_period_started_at" TIMESTAMP(3),
    "current_billing_period_ending_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "add_ons" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "invoice_display_name" TEXT,
    "amount_cents" INTEGER NOT NULL,
    "amount_currency" TEXT NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "add_ons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "add_on_tax_links" (
    "add_on_id" TEXT NOT NULL,
    "tax_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "add_on_tax_links_pkey" PRIMARY KEY ("add_on_id","tax_id")
);

-- CreateTable
CREATE TABLE "events" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "transaction_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "external_subscription_id" TEXT NOT NULL,
    "subscription_id" TEXT,
    "billable_metric_id" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "properties" JSONB NOT NULL DEFAULT '{}',
    "precision" TEXT NOT NULL DEFAULT 'seconds',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unit_labels" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "external_subscription_id" TEXT NOT NULL,
    "unit_external_id" TEXT NOT NULL,
    "label" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "unit_labels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "sequential_id" INTEGER NOT NULL,
    "number" TEXT,
    "issuing_date" DATE NOT NULL,
    "payment_due_date" DATE NOT NULL,
    "net_payment_term" INTEGER NOT NULL DEFAULT 0,
    "invoice_type" TEXT NOT NULL DEFAULT 'one_off',
    "status" TEXT NOT NULL DEFAULT 'calculated',
    "external_dispatch_status" TEXT NOT NULL DEFAULT 'pending',
    "external_dispatch_error" TEXT,
    "payment_status" TEXT NOT NULL DEFAULT 'pending',
    "payment_overdue" BOOLEAN NOT NULL DEFAULT false,
    "payment_dispute_lost_at" TIMESTAMP(3),
    "currency" TEXT NOT NULL,
    "fees_amount_cents" INTEGER NOT NULL DEFAULT 0,
    "taxes_amount_cents" INTEGER NOT NULL DEFAULT 0,
    "progressive_billing_credit_amount_cents" INTEGER NOT NULL DEFAULT 0,
    "coupons_amount_cents" INTEGER NOT NULL DEFAULT 0,
    "credit_notes_amount_cents" INTEGER NOT NULL DEFAULT 0,
    "sub_total_excluding_taxes_amount_cents" INTEGER NOT NULL DEFAULT 0,
    "sub_total_including_taxes_amount_cents" INTEGER NOT NULL DEFAULT 0,
    "total_amount_cents" INTEGER NOT NULL DEFAULT 0,
    "prepaid_credit_amount_cents" INTEGER NOT NULL DEFAULT 0,
    "file_url" TEXT,
    "version_number" INTEGER NOT NULL DEFAULT 1,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "units_annex" JSONB NOT NULL DEFAULT '[]',
    "error_details" JSONB NOT NULL DEFAULT '[]',
    "idempotency_key" TEXT,
    "external_invoice_folio" TEXT,
    "external_invoice_uuid_cfdi" TEXT,
    "external_invoice_system" TEXT,
    "external_invoice_netsuite_internal_id" TEXT,
    "external_invoice_pdf_url" TEXT,
    "external_invoice_xml_url" TEXT,
    "external_invoice_issued_at" TIMESTAMP(3),
    "external_invoice_confirmed_at" TIMESTAMP(3),
    "external_invoice_due_date" DATE,
    "netsuite_dispatch_id" TEXT,
    "netsuite_internal_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fees" (
    "id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "add_on_id" TEXT,
    "subscription_id" TEXT,
    "external_subscription_id" TEXT,
    "item_type" TEXT NOT NULL,
    "item_code" TEXT NOT NULL,
    "item_name" TEXT NOT NULL,
    "item_invoice_display_name" TEXT,
    "item_lago_item_id" TEXT NOT NULL,
    "item_class_type" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "amount_currency" TEXT NOT NULL,
    "taxes_amount_cents" INTEGER NOT NULL DEFAULT 0,
    "taxes_rate" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "total_amount_cents" INTEGER NOT NULL,
    "units" TEXT NOT NULL,
    "description" TEXT,
    "precise_unit_amount" TEXT NOT NULL,
    "billed_units_detail" JSONB NOT NULL DEFAULT '[]',
    "payment_status" TEXT NOT NULL DEFAULT 'pending',
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "applied_taxes" (
    "id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "tax_id" TEXT NOT NULL,
    "tax_name" TEXT NOT NULL,
    "tax_code" TEXT NOT NULL,
    "tax_rate" DECIMAL(10,4) NOT NULL,
    "tax_description" TEXT,
    "amount_cents" INTEGER NOT NULL,
    "amount_currency" TEXT NOT NULL,
    "fees_amount_cents" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "applied_taxes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_notes" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "sequential_id" INTEGER NOT NULL,
    "number" TEXT,
    "status" TEXT NOT NULL DEFAULT 'calculated',
    "external_dispatch_status" TEXT NOT NULL DEFAULT 'pending',
    "external_dispatch_error" TEXT,
    "credit_status" TEXT NOT NULL DEFAULT 'available',
    "refund_status" TEXT,
    "reason" TEXT NOT NULL,
    "description" TEXT,
    "currency" TEXT NOT NULL,
    "total_amount_cents" INTEGER NOT NULL,
    "taxes_amount_cents" INTEGER NOT NULL,
    "sub_total_excluding_taxes_amount_cents" INTEGER NOT NULL,
    "balance_amount_cents" INTEGER NOT NULL,
    "credit_amount_cents" INTEGER NOT NULL,
    "refund_amount_cents" INTEGER NOT NULL DEFAULT 0,
    "coupons_adjustment_amount_cents" INTEGER NOT NULL DEFAULT 0,
    "taxes_rate" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "file_url" TEXT,
    "issuing_date" DATE NOT NULL,
    "idempotency_marker" TEXT,
    "external_credit_note_folio" TEXT,
    "external_credit_note_uuid_cfdi" TEXT,
    "external_credit_note_system" TEXT,
    "external_credit_note_netsuite_id" TEXT,
    "external_credit_note_pdf_url" TEXT,
    "external_credit_note_xml_url" TEXT,
    "external_credit_note_issued_at" TIMESTAMP(3),
    "external_credit_note_confirmed_at" TIMESTAMP(3),
    "netsuite_dispatch_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credit_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_note_items" (
    "id" TEXT NOT NULL,
    "credit_note_id" TEXT NOT NULL,
    "fee_id" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "amount_currency" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_note_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_note_applied_taxes" (
    "id" TEXT NOT NULL,
    "credit_note_id" TEXT NOT NULL,
    "tax_id" TEXT NOT NULL,
    "tax_name" TEXT NOT NULL,
    "tax_code" TEXT NOT NULL,
    "tax_rate" DECIMAL(10,4) NOT NULL,
    "tax_description" TEXT,
    "amount_cents" INTEGER NOT NULL,
    "amount_currency" TEXT NOT NULL,
    "base_amount_cents" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_note_applied_taxes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response_status" INTEGER NOT NULL,
    "response_body" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "organizations_api_key_key" ON "organizations"("api_key");

-- CreateIndex
CREATE UNIQUE INDEX "customers_organization_id_external_id_key" ON "customers"("organization_id", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "taxes_organization_id_code_key" ON "taxes"("organization_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "billable_metrics_organization_id_code_key" ON "billable_metrics"("organization_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "plans_organization_id_code_key" ON "plans"("organization_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_organization_id_external_id_key" ON "subscriptions"("organization_id", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "add_ons_organization_id_code_key" ON "add_ons"("organization_id", "code");

-- CreateIndex
CREATE INDEX "events_external_subscription_id_timestamp_idx" ON "events"("external_subscription_id", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "events_organization_id_transaction_id_key" ON "events"("organization_id", "transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "unit_labels_customer_id_external_subscription_id_unit_exter_key" ON "unit_labels"("customer_id", "external_subscription_id", "unit_external_id");

-- CreateIndex
CREATE INDEX "fees_invoice_id_idx" ON "fees"("invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_organization_id_path_key_key" ON "idempotency_records"("organization_id", "path", "key");

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "taxes" ADD CONSTRAINT "taxes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_tax_links" ADD CONSTRAINT "customer_tax_links_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_tax_links" ADD CONSTRAINT "customer_tax_links_tax_id_fkey" FOREIGN KEY ("tax_id") REFERENCES "taxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billable_metrics" ADD CONSTRAINT "billable_metrics_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plans" ADD CONSTRAINT "plans_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charges" ADD CONSTRAINT "charges_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charges" ADD CONSTRAINT "charges_billable_metric_id_fkey" FOREIGN KEY ("billable_metric_id") REFERENCES "billable_metrics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "add_ons" ADD CONSTRAINT "add_ons_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "add_on_tax_links" ADD CONSTRAINT "add_on_tax_links_add_on_id_fkey" FOREIGN KEY ("add_on_id") REFERENCES "add_ons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "add_on_tax_links" ADD CONSTRAINT "add_on_tax_links_tax_id_fkey" FOREIGN KEY ("tax_id") REFERENCES "taxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_billable_metric_id_fkey" FOREIGN KEY ("billable_metric_id") REFERENCES "billable_metrics"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unit_labels" ADD CONSTRAINT "unit_labels_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fees" ADD CONSTRAINT "fees_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fees" ADD CONSTRAINT "fees_add_on_id_fkey" FOREIGN KEY ("add_on_id") REFERENCES "add_ons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applied_taxes" ADD CONSTRAINT "applied_taxes_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_note_items" ADD CONSTRAINT "credit_note_items_credit_note_id_fkey" FOREIGN KEY ("credit_note_id") REFERENCES "credit_notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_note_items" ADD CONSTRAINT "credit_note_items_fee_id_fkey" FOREIGN KEY ("fee_id") REFERENCES "fees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_note_applied_taxes" ADD CONSTRAINT "credit_note_applied_taxes_credit_note_id_fkey" FOREIGN KEY ("credit_note_id") REFERENCES "credit_notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
