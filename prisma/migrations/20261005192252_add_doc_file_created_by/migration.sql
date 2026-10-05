-- AlterTable
ALTER TABLE "doc" ADD COLUMN     "created_by_user_id" TEXT;

-- AlterTable
ALTER TABLE "file" ADD COLUMN     "created_by_user_id" TEXT;

-- AddForeignKey
ALTER TABLE "doc" ADD CONSTRAINT "doc_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file" ADD CONSTRAINT "file_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Who uploaded each existing file. An upload makes its uploader the sole
-- `file_owner`, so the first owner is the uploader unless the list has been
-- edited since; first by `owner_order`, then `user_id` so a tie has one
-- answer. A file with no owner left (its only owner hard-deleted) stays
-- NULL. Raw SQL leaves `updated_at` alone, and names neither column the
-- search-vector trigger watches.
--
-- Docs are filled by scripts/doc/backfill-created-by.ts after this: their
-- answer comes from replaying each ydoc's update log, which SQL can't.
UPDATE "file" AS f
SET "created_by_user_id" = o."user_id"
FROM (
  SELECT DISTINCT ON ("file_id") "file_id", "user_id"
  FROM "file_owner"
  ORDER BY "file_id", "owner_order", "user_id"
) AS o
WHERE o."file_id" = f."id";
