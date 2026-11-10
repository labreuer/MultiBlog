-- CreateTable
CREATE TABLE "reference_import_receipt" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "import_id" TEXT NOT NULL,
    "place" INTEGER NOT NULL,
    "outcome" TEXT NOT NULL,
    "key" TEXT,
    "detail" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reference_import_receipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reference_import_receipt_user_id_created_at_idx" ON "reference_import_receipt"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "reference_import_receipt_user_id_import_id_place_key" ON "reference_import_receipt"("user_id", "import_id", "place");

-- AddForeignKey
ALTER TABLE "reference_import_receipt" ADD CONSTRAINT "reference_import_receipt_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

