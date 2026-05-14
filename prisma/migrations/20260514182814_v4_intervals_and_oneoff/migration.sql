/*
  Warnings:

  - You are about to drop the column `billing_time` on the `customers` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "customers" DROP COLUMN "billing_time",
ADD COLUMN     "billing_anchor_day" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "billing_period_months" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "nonrecurring_trigger" TEXT NOT NULL DEFAULT 'next_cycle';

-- AlterTable
ALTER TABLE "services" ADD COLUMN     "pricing_model" TEXT NOT NULL DEFAULT 'recurring';

-- AlterTable
ALTER TABLE "units" ADD COLUMN     "oneoff_billed_at" TIMESTAMP(3);
