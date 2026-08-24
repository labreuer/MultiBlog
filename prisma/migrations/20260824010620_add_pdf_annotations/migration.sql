-- AlterTable
ALTER TABLE "annotation" ADD COLUMN     "file_id" TEXT,
ADD COLUMN     "pdf_target" JSONB,
ALTER COLUMN "doc_id" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "annotation_file_id_idx" ON "annotation"("file_id");

-- AddForeignKey
ALTER TABLE "annotation" ADD CONSTRAINT "annotation_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "file"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Appended by hand to Branch C's generated migration (Prisma emits neither
-- CHECK constraints nor views).

-- PLAN.md §19 — an annotation hangs off a doc or off an uploaded file, never
-- both and never neither. docId was NOT NULL until PDF annotations arrived;
-- loosening it needs no backfill, since every pre-existing row keeps the doc it
-- had. Prisma has no CHECK DSL, the same reason DocLink's mark_id/mark pair is
-- hand-written.
ALTER TABLE "annotation"
  ADD CONSTRAINT "annotation_one_container_check"
  CHECK (("doc_id" IS NOT NULL) <> ("file_id" IS NOT NULL));

-- /files' Annotations column joins the view now that annotation.file_id exists.
-- A filtered count (non-deleted, non-DRAFT), which Prisma's `_count` has no way
-- to express in an orderBy — the reason it lives in the view at all.
--
-- FULL OUTER JOIN, not a plain join off file_owner: a file can have annotations
-- and no owners, or owners and no annotations, and both still need a row.
DROP VIEW "file_metrics";
CREATE VIEW file_metrics AS
SELECT COALESCE(owners.file_id, notes.file_id) AS file_id,
       owners.owners                           AS owners,
       COALESCE(notes.annotation_count, 0)     AS annotation_count
FROM (
    SELECT fo.file_id,
           string_agg(u.admin_initials, ', ' ORDER BY fo.owner_order) AS owners
    FROM file_owner fo
    JOIN "user" u ON u.id = fo.user_id
    GROUP BY fo.file_id
) owners
FULL OUTER JOIN (
    SELECT a.file_id,
           count(*)::int AS annotation_count
    FROM annotation a
    WHERE a.file_id IS NOT NULL
      AND a.deleted_at IS NULL
      AND a.status <> 'DRAFT'
    GROUP BY a.file_id
) notes ON notes.file_id = owners.file_id;
