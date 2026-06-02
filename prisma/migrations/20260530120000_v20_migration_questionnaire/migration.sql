-- CreateTable
CREATE TABLE "migration_questionnaire" (
    "id" TEXT NOT NULL,
    "filled_by_name" TEXT NOT NULL,
    "filled_by_email" TEXT,
    "customer_label" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "migration_questionnaire_pkey" PRIMARY KEY ("id")
);
