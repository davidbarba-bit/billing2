-- AlterTable
ALTER TABLE "fees" ADD COLUMN     "add_on_id" TEXT;

-- CreateTable
CREATE TABLE "add_ons" (
    "id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "pricing_type" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "active_from" TIMESTAMP(3) NOT NULL,
    "active_to" TIMESTAMP(3),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "add_ons_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "add_ons_service_id_active_to_idx" ON "add_ons"("service_id", "active_to");

-- CreateIndex
CREATE UNIQUE INDEX "add_ons_service_id_code_key" ON "add_ons"("service_id", "code");

-- AddForeignKey
ALTER TABLE "add_ons" ADD CONSTRAINT "add_ons_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fees" ADD CONSTRAINT "fees_add_on_id_fkey" FOREIGN KEY ("add_on_id") REFERENCES "add_ons"("id") ON DELETE SET NULL ON UPDATE CASCADE;
