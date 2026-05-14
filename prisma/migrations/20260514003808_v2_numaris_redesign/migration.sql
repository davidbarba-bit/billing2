/*
  Warnings:

  - You are about to drop the column `coupons_adjustment_amount_cents` on the `credit_notes` table. All the data in the column will be lost.
  - You are about to drop the column `customer_type` on the `customers` table. All the data in the column will be lost.
  - You are about to drop the column `external_salesforce_id` on the `customers` table. All the data in the column will be lost.
  - You are about to drop the column `finalize_zero_amount_invoice` on the `customers` table. All the data in the column will be lost.
  - You are about to drop the column `firstname` on the `customers` table. All the data in the column will be lost.
  - You are about to drop the column `lastname` on the `customers` table. All the data in the column will be lost.
  - You are about to drop the column `legal_name` on the `customers` table. All the data in the column will be lost.
  - You are about to drop the column `legal_number` on the `customers` table. All the data in the column will be lost.
  - You are about to drop the column `logo_url` on the `customers` table. All the data in the column will be lost.
  - You are about to drop the column `net_payment_term` on the `customers` table. All the data in the column will be lost.
  - You are about to drop the column `shipping_address_line1` on the `customers` table. All the data in the column will be lost.
  - You are about to drop the column `shipping_address_line2` on the `customers` table. All the data in the column will be lost.
  - You are about to drop the column `shipping_city` on the `customers` table. All the data in the column will be lost.
  - You are about to drop the column `shipping_country` on the `customers` table. All the data in the column will be lost.
  - You are about to drop the column `shipping_state` on the `customers` table. All the data in the column will be lost.
  - You are about to drop the column `shipping_zipcode` on the `customers` table. All the data in the column will be lost.
  - You are about to drop the column `url` on the `customers` table. All the data in the column will be lost.
  - You are about to drop the column `add_on_id` on the `fees` table. All the data in the column will be lost.
  - You are about to drop the column `amount_currency` on the `fees` table. All the data in the column will be lost.
  - You are about to drop the column `external_subscription_id` on the `fees` table. All the data in the column will be lost.
  - You are about to drop the column `item_class_type` on the `fees` table. All the data in the column will be lost.
  - You are about to drop the column `item_code` on the `fees` table. All the data in the column will be lost.
  - You are about to drop the column `item_invoice_display_name` on the `fees` table. All the data in the column will be lost.
  - You are about to drop the column `item_lago_item_id` on the `fees` table. All the data in the column will be lost.
  - You are about to drop the column `item_name` on the `fees` table. All the data in the column will be lost.
  - You are about to drop the column `item_type` on the `fees` table. All the data in the column will be lost.
  - You are about to drop the column `subscription_id` on the `fees` table. All the data in the column will be lost.
  - You are about to drop the column `coupons_amount_cents` on the `invoices` table. All the data in the column will be lost.
  - You are about to drop the column `credit_notes_amount_cents` on the `invoices` table. All the data in the column will be lost.
  - You are about to drop the column `error_details` on the `invoices` table. All the data in the column will be lost.
  - You are about to drop the column `file_url` on the `invoices` table. All the data in the column will be lost.
  - You are about to drop the column `invoice_type` on the `invoices` table. All the data in the column will be lost.
  - You are about to drop the column `netsuite_internal_id` on the `invoices` table. All the data in the column will be lost.
  - You are about to drop the column `payment_dispute_lost_at` on the `invoices` table. All the data in the column will be lost.
  - You are about to drop the column `payment_overdue` on the `invoices` table. All the data in the column will be lost.
  - You are about to drop the column `prepaid_credit_amount_cents` on the `invoices` table. All the data in the column will be lost.
  - You are about to drop the column `progressive_billing_credit_amount_cents` on the `invoices` table. All the data in the column will be lost.
  - You are about to drop the column `sub_total_excluding_taxes_amount_cents` on the `invoices` table. All the data in the column will be lost.
  - You are about to drop the column `sub_total_including_taxes_amount_cents` on the `invoices` table. All the data in the column will be lost.
  - You are about to drop the column `version_number` on the `invoices` table. All the data in the column will be lost.
  - You are about to drop the column `applied_to_organization` on the `taxes` table. All the data in the column will be lost.
  - You are about to drop the `add_on_tax_links` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `add_ons` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `billable_metrics` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `charges` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `events` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `plans` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `subscriptions` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `unit_labels` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `kind` to the `fees` table without a default value. This is not possible if the table is not empty.
  - Added the required column `unit_amount_cents` to the `fees` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "add_on_tax_links" DROP CONSTRAINT "add_on_tax_links_add_on_id_fkey";

-- DropForeignKey
ALTER TABLE "add_on_tax_links" DROP CONSTRAINT "add_on_tax_links_tax_id_fkey";

-- DropForeignKey
ALTER TABLE "add_ons" DROP CONSTRAINT "add_ons_organization_id_fkey";

-- DropForeignKey
ALTER TABLE "billable_metrics" DROP CONSTRAINT "billable_metrics_organization_id_fkey";

-- DropForeignKey
ALTER TABLE "charges" DROP CONSTRAINT "charges_billable_metric_id_fkey";

-- DropForeignKey
ALTER TABLE "charges" DROP CONSTRAINT "charges_plan_id_fkey";

-- DropForeignKey
ALTER TABLE "events" DROP CONSTRAINT "events_billable_metric_id_fkey";

-- DropForeignKey
ALTER TABLE "events" DROP CONSTRAINT "events_organization_id_fkey";

-- DropForeignKey
ALTER TABLE "events" DROP CONSTRAINT "events_subscription_id_fkey";

-- DropForeignKey
ALTER TABLE "fees" DROP CONSTRAINT "fees_add_on_id_fkey";

-- DropForeignKey
ALTER TABLE "plans" DROP CONSTRAINT "plans_organization_id_fkey";

-- DropForeignKey
ALTER TABLE "subscriptions" DROP CONSTRAINT "subscriptions_customer_id_fkey";

-- DropForeignKey
ALTER TABLE "subscriptions" DROP CONSTRAINT "subscriptions_plan_id_fkey";

-- DropForeignKey
ALTER TABLE "unit_labels" DROP CONSTRAINT "unit_labels_customer_id_fkey";

-- AlterTable
ALTER TABLE "credit_notes" DROP COLUMN "coupons_adjustment_amount_cents";

-- AlterTable
ALTER TABLE "customers" DROP COLUMN "customer_type",
DROP COLUMN "external_salesforce_id",
DROP COLUMN "finalize_zero_amount_invoice",
DROP COLUMN "firstname",
DROP COLUMN "lastname",
DROP COLUMN "legal_name",
DROP COLUMN "legal_number",
DROP COLUMN "logo_url",
DROP COLUMN "net_payment_term",
DROP COLUMN "shipping_address_line1",
DROP COLUMN "shipping_address_line2",
DROP COLUMN "shipping_city",
DROP COLUMN "shipping_country",
DROP COLUMN "shipping_state",
DROP COLUMN "shipping_zipcode",
DROP COLUMN "url";

-- AlterTable
ALTER TABLE "fees" DROP COLUMN "add_on_id",
DROP COLUMN "amount_currency",
DROP COLUMN "external_subscription_id",
DROP COLUMN "item_class_type",
DROP COLUMN "item_code",
DROP COLUMN "item_invoice_display_name",
DROP COLUMN "item_lago_item_id",
DROP COLUMN "item_name",
DROP COLUMN "item_type",
DROP COLUMN "subscription_id",
ADD COLUMN     "kind" TEXT NOT NULL,
ADD COLUMN     "service_id" TEXT,
ADD COLUMN     "unit_amount_cents" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "invoices" DROP COLUMN "coupons_amount_cents",
DROP COLUMN "credit_notes_amount_cents",
DROP COLUMN "error_details",
DROP COLUMN "file_url",
DROP COLUMN "invoice_type",
DROP COLUMN "netsuite_internal_id",
DROP COLUMN "payment_dispute_lost_at",
DROP COLUMN "payment_overdue",
DROP COLUMN "prepaid_credit_amount_cents",
DROP COLUMN "progressive_billing_credit_amount_cents",
DROP COLUMN "sub_total_excluding_taxes_amount_cents",
DROP COLUMN "sub_total_including_taxes_amount_cents",
DROP COLUMN "version_number",
ADD COLUMN     "period_from" TIMESTAMP(3),
ADD COLUMN     "period_to" TIMESTAMP(3),
ADD COLUMN     "service_id" TEXT;

-- AlterTable
ALTER TABLE "taxes" DROP COLUMN "applied_to_organization";

-- DropTable
DROP TABLE "add_on_tax_links";

-- DropTable
DROP TABLE "add_ons";

-- DropTable
DROP TABLE "billable_metrics";

-- DropTable
DROP TABLE "charges";

-- DropTable
DROP TABLE "events";

-- DropTable
DROP TABLE "plans";

-- DropTable
DROP TABLE "subscriptions";

-- DropTable
DROP TABLE "unit_labels";

-- CreateTable
CREATE TABLE "services" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "currency" TEXT NOT NULL,
    "monthly_unit_amount_cents" INTEGER NOT NULL DEFAULT 0,
    "setup_unit_amount_cents" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "billing_time" TEXT NOT NULL DEFAULT 'calendar',
    "subscription_at" TIMESTAMP(3) NOT NULL,
    "started_at" TIMESTAMP(3),
    "terminated_at" TIMESTAMP(3),
    "current_billing_period_started_at" TIMESTAMP(3),
    "current_billing_period_ending_at" TIMESTAMP(3),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_tax_links" (
    "service_id" TEXT NOT NULL,
    "tax_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_tax_links_pkey" PRIMARY KEY ("service_id","tax_id")
);

-- CreateTable
CREATE TABLE "units" (
    "id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "label" TEXT,
    "active_from" TIMESTAMP(3) NOT NULL,
    "active_to" TIMESTAMP(3),
    "setup_billed_at" TIMESTAMP(3),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_log" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "transaction_id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "unit_id" TEXT,
    "unit_external_id" TEXT NOT NULL,
    "unit_label" TEXT,
    "operation_type" TEXT NOT NULL,
    "kind" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "properties" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "services_customer_id_idx" ON "services"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "services_organization_id_code_key" ON "services"("organization_id", "code");

-- CreateIndex
CREATE INDEX "units_service_id_active_to_idx" ON "units"("service_id", "active_to");

-- CreateIndex
CREATE UNIQUE INDEX "units_service_id_external_id_key" ON "units"("service_id", "external_id");

-- CreateIndex
CREATE INDEX "event_log_service_id_timestamp_idx" ON "event_log"("service_id", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "event_log_organization_id_transaction_id_key" ON "event_log"("organization_id", "transaction_id");

-- AddForeignKey
ALTER TABLE "services" ADD CONSTRAINT "services_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "services" ADD CONSTRAINT "services_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_tax_links" ADD CONSTRAINT "service_tax_links_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_tax_links" ADD CONSTRAINT "service_tax_links_tax_id_fkey" FOREIGN KEY ("tax_id") REFERENCES "taxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "units" ADD CONSTRAINT "units_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_log" ADD CONSTRAINT "event_log_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_log" ADD CONSTRAINT "event_log_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_log" ADD CONSTRAINT "event_log_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fees" ADD CONSTRAINT "fees_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applied_taxes" ADD CONSTRAINT "applied_taxes_tax_id_fkey" FOREIGN KEY ("tax_id") REFERENCES "taxes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_note_applied_taxes" ADD CONSTRAINT "credit_note_applied_taxes_tax_id_fkey" FOREIGN KEY ("tax_id") REFERENCES "taxes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
