-- AlterTable
ALTER TABLE "services" ADD COLUMN     "prepaid_months_default" INTEGER;

-- AlterTable
ALTER TABLE "units" ADD COLUMN     "prepaid_months" INTEGER;
