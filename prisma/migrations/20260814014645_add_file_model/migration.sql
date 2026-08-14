-- AlterTable
ALTER TABLE "annotation" ADD COLUMN     "file_id" TEXT,
ADD COLUMN     "pdf_target" JSONB,
ALTER COLUMN "doc_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "file" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "page_count" INTEGER,
    "visibility" "doc_visibility" NOT NULL DEFAULT 'PRIVATE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_user_id" TEXT,
    "deleted_by_user_id" TEXT,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "file_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_author" (
    "file_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "byline_order" INTEGER NOT NULL,

    CONSTRAINT "file_author_pkey" PRIMARY KEY ("file_id","user_id")
);

-- CreateTable
CREATE TABLE "file_slug_history" (
    "id" TEXT NOT NULL,
    "file_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "file_slug_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_page_text" (
    "file_id" TEXT NOT NULL,
    "page_index" INTEGER NOT NULL,
    "text_version" TEXT NOT NULL,
    "text" TEXT NOT NULL,

    CONSTRAINT "file_page_text_pkey" PRIMARY KEY ("file_id","page_index","text_version")
);

-- CreateIndex
CREATE UNIQUE INDEX "file_slug_key" ON "file"("slug");

-- CreateIndex
CREATE INDEX "file_sha256_idx" ON "file"("sha256");

-- CreateIndex
CREATE UNIQUE INDEX "file_slug_history_slug_key" ON "file_slug_history"("slug");

-- CreateIndex
CREATE INDEX "file_slug_history_file_id_idx" ON "file_slug_history"("file_id");

-- CreateIndex
CREATE INDEX "annotation_file_id_idx" ON "annotation"("file_id");

-- AddForeignKey
ALTER TABLE "annotation" ADD CONSTRAINT "annotation_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "file"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file" ADD CONSTRAINT "file_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file" ADD CONSTRAINT "file_deleted_by_user_id_fkey" FOREIGN KEY ("deleted_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_author" ADD CONSTRAINT "file_author_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "file"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_author" ADD CONSTRAINT "file_author_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_slug_history" ADD CONSTRAINT "file_slug_history_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "file"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_page_text" ADD CONSTRAINT "file_page_text_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "file"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- PLAN.md §19 — exactly one container per annotation. Prisma has no CHECK DSL,
-- so this is hand-written here, the same way doc_link's mark_id/mark exclusion
-- is. Every pre-existing row satisfies it by construction: doc_id was NOT NULL
-- until the ALTER above and file_id is new, so `true <> false` holds for all of
-- them.
--
-- Written as `<>` on two IS NOT NULL tests rather than a pair of ORed AND
-- clauses because it says the intended thing directly — one and only one — and
-- because it also rejects the *neither* case, which a naive
-- "(a IS NULL OR b IS NULL)" would let through.
ALTER TABLE "annotation"
  ADD CONSTRAINT "annotation_one_container_check"
  CHECK (("doc_id" IS NOT NULL) <> ("file_id" IS NOT NULL));

-- /files' Author(s) and Annotations columns (PLAN.md §19). Same job doc_metrics
-- does for /docs, and the same hard rule: **this view never references `file`.**
-- Prisma emits a LEFT JOIN back to the base table when ordering through a
-- to-one relation, and Postgres 18's self-join elimination only collapses INNER
-- joins, so a view that read `file` would make every sort through it scan that
-- table twice (see add_doc_metrics_view for the full account).
--
-- Two aggregates from two different tables, so this is a FULL OUTER JOIN of two
-- grouped subqueries rather than doc_metrics' single GROUP BY. The join is
-- FULL, not LEFT, because either side can exist without the other: a file with
-- annotations but no byline, or a byline with no annotations yet.
--
-- annotation_count excludes DRAFT as well as soft-deleted rows. Soft-deleted is
-- obvious; DRAFT matters because a draft is invisible to everyone but its
-- author (PLAN.md §13d), and a count that moved when someone else opened a
-- composer would leak exactly what that rule hides. Replies are counted along
-- with roots — the column answers "how much conversation is on this", not "how
-- many threads".
--
-- COALESCE on the count (but not on byline) is what lets Prisma declare
-- annotationCount as a non-null Int while byline stays String?: a view's
-- columns carry no NOT NULL of their own, so the guarantee has to come from the
-- expression. A file with neither authors nor annotations has no row here at
-- all — the same harmless semantic doc_metrics has, handled by the page reading
-- `metrics?.annotationCount ?? 0`.
CREATE VIEW file_metrics AS
SELECT COALESCE(authors.file_id, notes.file_id) AS file_id,
       authors.byline                           AS byline,
       COALESCE(notes.annotation_count, 0)      AS annotation_count
FROM (
    SELECT fa.file_id,
           string_agg(u.admin_initials, ', ' ORDER BY fa.byline_order) AS byline
    FROM file_author fa
    JOIN "user" u ON u.id = fa.user_id
    GROUP BY fa.file_id
) authors
FULL OUTER JOIN (
    SELECT a.file_id,
           count(*)::int AS annotation_count
    FROM annotation a
    WHERE a.file_id IS NOT NULL
      AND a.deleted_at IS NULL
      AND a.status <> 'DRAFT'
    GROUP BY a.file_id
) notes ON notes.file_id = authors.file_id;
