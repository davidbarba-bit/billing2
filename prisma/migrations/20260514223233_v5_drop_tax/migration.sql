/*
  Warnings:

  - You are about to drop the column `sub_total_excluding_taxes_amount_cents` on the `credit_notes` table. All the data in the column will be lost.
  - You are about to drop the column `taxes_amount_cents` on the `credit_notes` table. All the data in the column will be lost.
  - You are about to drop the column `taxes_rate` on the `credit_notes` table. All the data in the column will be lost.
  - You are about to drop the column `taxes_amount_cents` on the `fees` table. All the data in the column will be lost.
  - You are about to drop the column `taxes_rate` on the `fees` table. All the data in the column will be lost.
  - You are about to drop the column `total_amount_cents` on the `fees` table. All the data in the column will be lost.
  - You are about to drop the column `taxes_amount_cents` on the `invoices` table. All the data in the column will be lost.
  - You are about to drop the column `total_amount_cents` on the `invoices` table. All the data in the column will be lost.
  - You are about to drop the `applied_taxes` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `credit_note_applied_taxes` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `customer_tax_links` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `service_tax_links` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `taxes` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "applied_taxes" DROP CONSTRAINT "applied_taxes_invoice_id_fkey";

-- DropForeignKey
ALTER TABLE "applied_taxes" DROP CONSTRAINT "applied_taxes_tax_id_fkey";

-- DropForeignKey
ALTER TABLE "credit_note_applied_taxes" DROP CONSTRAINT "credit_note_applied_taxes_credit_note_id_fkey";

-- DropForeignKey
ALTER TABLE "credit_note_applied_taxes" DROP CONSTRAINT "credit_note_applied_taxes_tax_id_fkey";

-- DropForeignKey
ALTER TABLE "customer_tax_links" DROP CONSTRAINT "customer_tax_links_customer_id_fkey";

-- DropForeignKey
ALTER TABLE "customer_tax_links" DROP CONSTRAINT "customer_tax_links_tax_id_fkey";

-- DropForeignKey
ALTER TABLE "service_tax_links" DROP CONSTRAINT "service_tax_links_service_id_fkey";

-- DropForeignKey
ALTER TABLE "service_tax_links" DROP CONSTRAINT "service_tax_links_tax_id_fkey";

-- DropForeignKey
ALTER TABLE "taxes" DROP CONSTRAINT "taxes_organization_id_fkey";

-- AlterTable
ALTER TABLE "credit_notes" DROP COLUMN "sub_total_excluding_taxes_amount_cents",
DROP COLUMN "taxes_amount_cents",
DROP COLUMN "taxes_rate";

-- AlterTable
ALTER TABLE "fees" DROP COLUMN "taxes_amount_cents",
DROP COLUMN "taxes_rate",
DROP COLUMN "total_amount_cents";

-- AlterTable
ALTER TABLE "invoices" DROP COLUMN "taxes_amount_cents",
DROP COLUMN "total_amount_cents";

-- DropTable
DROP TABLE "applied_taxes";

-- DropTable
DROP TABLE "credit_note_applied_taxes";

-- DropTable
DROP TABLE "customer_tax_links";

-- DropTable
DROP TABLE "service_tax_links";

-- DropTable
DROP TABLE "taxes";
