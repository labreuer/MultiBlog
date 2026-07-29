-- CreateEnum
CREATE TYPE "doc_visibility" AS ENUM ('PRIVATE', 'SHARED');

-- CreateTable
CREATE TABLE "doc" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "visibility" "doc_visibility" NOT NULL DEFAULT 'PRIVATE',
    "prose_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_by_user_id" TEXT,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "doc_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doc_author" (
    "doc_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "byline_order" INTEGER NOT NULL,

    CONSTRAINT "doc_author_pkey" PRIMARY KEY ("doc_id","user_id")
);

-- CreateTable
CREATE TABLE "doc_slug_history" (
    "id" TEXT NOT NULL,
    "doc_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "doc_slug_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "doc_slug_key" ON "doc"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "doc_slug_history_slug_key" ON "doc_slug_history"("slug");

-- CreateIndex
CREATE INDEX "doc_slug_history_doc_id_idx" ON "doc_slug_history"("doc_id");

-- AddForeignKey
ALTER TABLE "doc" ADD CONSTRAINT "doc_deleted_by_user_id_fkey" FOREIGN KEY ("deleted_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doc_author" ADD CONSTRAINT "doc_author_doc_id_fkey" FOREIGN KEY ("doc_id") REFERENCES "doc"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doc_author" ADD CONSTRAINT "doc_author_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doc_slug_history" ADD CONSTRAINT "doc_slug_history_doc_id_fkey" FOREIGN KEY ("doc_id") REFERENCES "doc"("id") ON DELETE CASCADE ON UPDATE CASCADE;
