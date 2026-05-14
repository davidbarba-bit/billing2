/*
  Warnings:

  - You are about to drop the column `add_on_id` on the `fees` table. All the data in the column will be lost.
  - You are about to drop the column `service_id` on the `invoices` table. All the data in the column will be lost.
  - You are about to drop the column `billing_time` on the `services` table. All the data in the column will be lost.
  - You are about to drop the column `current_billing_period_ending_at` on the `services` table. All the data in the column will be lost.
  - You are about to drop the column `current_billing_period_started_at` on the `services` table. All the data in the column will be lost.
  - You are about to drop the column `started_at` on the `services` table. All the data in the column will be lost.
  - You are about to drop the column `subscription_at` on the `services` table. All the data in the column will be lost.
  - You are about to drop the `add_ons` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `subscription_at` to the `customers` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "add_ons" DROP CONSTRAINT "add_ons_service_id_fkey";

-- DropForeignKey
ALTER TABLE "fees" DROP CONSTRAINT "fees_add_on_id_fkey";

-- DropForeignKey
ALTER TABLE "invoices" DROP CONSTRAINT "invoices_service_id_fkey";

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "billing_time" TEXT NOT NULL DEFAULT 'calendar',
ADD COLUMN     "current_billing_period_ending_at" TIMESTAMP(3),
ADD COLUMN     "current_billing_period_started_at" TIMESTAMP(3),
ADD COLUMN     "started_at" TIMESTAMP(3),
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'active',
ADD COLUMN     "subscription_at" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "terminated_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "fees" DROP COLUMN "add_on_id",
ADD COLUMN     "customer_add_on_id" TEXT,
ADD COLUMN     "service_add_on_id" TEXT;

-- AlterTable
ALTER TABLE "invoices" DROP COLUMN "service_id";

-- AlterTable
ALTER TABLE "services" DROP COLUMN "billing_time",
DROP COLUMN "current_billing_period_ending_at",
DROP COLUMN "current_billing_period_started_at",
DROP COLUMN "started_at",
DROP COLUMN "subscription_at";

-- DropTable
DROP TABLE "add_ons";

-- CreateTable
CREATE TABLE "service_add_ons" (
    "id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "amount_cents" INTEGER NOT NULL,
    "active_from" TIMESTAMP(3) NOT NULL,
    "active_to" TIMESTAMP(3),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_add_ons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_add_ons" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "amount_cents" INTEGER NOT NULL,
    "active_from" TIMESTAMP(3) NOT NULL,
    "active_to" TIMESTAMP(3),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_add_ons_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "service_add_ons_service_id_active_to_idx" ON "service_add_ons"("service_id", "active_to");

-- CreateIndex
CREATE UNIQUE INDEX "service_add_ons_service_id_code_key" ON "service_add_ons"("service_id", "code");

-- CreateIndex
CREATE INDEX "customer_add_ons_customer_id_active_to_idx" ON "customer_add_ons"("customer_id", "active_to");

-- CreateIndex
CREATE UNIQUE INDEX "customer_add_ons_customer_id_code_key" ON "customer_add_ons"("customer_id", "code");

-- AddForeignKey
ALTER TABLE "service_add_ons" ADD CONSTRAINT "service_add_ons_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_add_ons" ADD CONSTRAINT "customer_add_ons_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fees" ADD CONSTRAINT "fees_service_add_on_id_fkey" FOREIGN KEY ("service_add_on_id") REFERENCES "service_add_ons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fees" ADD CONSTRAINT "fees_customer_add_on_id_fkey" FOREIGN KEY ("customer_add_on_id") REFERENCES "customer_add_ons"("id") ON DELETE SET NULL ON UPDATE CASCADE;
