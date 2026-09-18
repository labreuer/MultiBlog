-- AlterTable
ALTER TABLE "anchored_link_anchor" ADD COLUMN     "target_comment_id" TEXT;

-- AlterTable
ALTER TABLE "tag_anchor" ADD COLUMN     "target_comment_id" TEXT;

-- CreateTable
CREATE TABLE "comment_quote_anchor" (
    "id" TEXT NOT NULL,
    "comment_id" TEXT NOT NULL,
    "part_order" INTEGER NOT NULL DEFAULT 0,
    "doc_id" TEXT,
    "post_id" TEXT,
    "file_id" TEXT,
    "target_annotation_id" TEXT,
    "target_comment_id" TEXT,
    "selector_kind" "selector_kind",
    "anchor_from" INTEGER,
    "anchor_to" INTEGER,
    "quoted_text" TEXT NOT NULL DEFAULT '',
    "selector" JSONB,
    "ydoc_update_id" BIGINT,
    "anchored_event_id" TEXT,
    "quoted_revision_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comment_quote_anchor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "comment_quote_anchor_comment_id_idx" ON "comment_quote_anchor"("comment_id");

-- CreateIndex
CREATE INDEX "comment_quote_anchor_doc_id_idx" ON "comment_quote_anchor"("doc_id");

-- CreateIndex
CREATE INDEX "comment_quote_anchor_post_id_idx" ON "comment_quote_anchor"("post_id");

-- CreateIndex
CREATE INDEX "comment_quote_anchor_file_id_idx" ON "comment_quote_anchor"("file_id");

-- CreateIndex
CREATE INDEX "comment_quote_anchor_target_annotation_id_idx" ON "comment_quote_anchor"("target_annotation_id");

-- CreateIndex
CREATE INDEX "comment_quote_anchor_target_comment_id_idx" ON "comment_quote_anchor"("target_comment_id");

-- CreateIndex
CREATE INDEX "comment_quote_anchor_quoted_revision_id_idx" ON "comment_quote_anchor"("quoted_revision_id");

-- CreateIndex
CREATE INDEX "anchored_link_anchor_target_comment_id_idx" ON "anchored_link_anchor"("target_comment_id");

-- CreateIndex
CREATE INDEX "tag_anchor_target_comment_id_idx" ON "tag_anchor"("target_comment_id");

-- AddForeignKey
ALTER TABLE "comment_quote_anchor" ADD CONSTRAINT "comment_quote_anchor_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_quote_anchor" ADD CONSTRAINT "comment_quote_anchor_doc_id_fkey" FOREIGN KEY ("doc_id") REFERENCES "doc"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_quote_anchor" ADD CONSTRAINT "comment_quote_anchor_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_quote_anchor" ADD CONSTRAINT "comment_quote_anchor_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "file"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_quote_anchor" ADD CONSTRAINT "comment_quote_anchor_target_annotation_id_fkey" FOREIGN KEY ("target_annotation_id") REFERENCES "annotation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_quote_anchor" ADD CONSTRAINT "comment_quote_anchor_target_comment_id_fkey" FOREIGN KEY ("target_comment_id") REFERENCES "comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_quote_anchor" ADD CONSTRAINT "comment_quote_anchor_anchored_event_id_fkey" FOREIGN KEY ("anchored_event_id") REFERENCES "post_publication_event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_quote_anchor" ADD CONSTRAINT "comment_quote_anchor_quoted_revision_id_fkey" FOREIGN KEY ("quoted_revision_id") REFERENCES "comment_revision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tag_anchor" ADD CONSTRAINT "tag_anchor_target_comment_id_fkey" FOREIGN KEY ("target_comment_id") REFERENCES "comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "anchored_link_anchor" ADD CONSTRAINT "anchored_link_anchor_target_comment_id_fkey" FOREIGN KEY ("target_comment_id") REFERENCES "comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-written below this line (the add_tags / add_anchored_links convention
-- — appended to the --create-only SQL before first apply; Prisma has no CHECK
-- DSL). PLAN.md §23c.

-- PLAN.md §23c — a fifth targetable kind is a migration: one column, one
-- index, one CHECK edit, per anchor table (CLAUDE.md's "one anchor row
-- shape"). The column and index above are Prisma's; the CHECKs are rewritten
-- here to count it, on both existing tables and on the new one.
ALTER TABLE "tag_anchor" DROP CONSTRAINT "tag_anchor_one_target_check";
ALTER TABLE "tag_anchor"
  ADD CONSTRAINT "tag_anchor_one_target_check"
  CHECK (num_nonnulls("doc_id", "post_id", "file_id", "target_annotation_id", "target_comment_id") = 1);

ALTER TABLE "anchored_link_anchor" DROP CONSTRAINT "anchored_link_anchor_one_target_check";
ALTER TABLE "anchored_link_anchor"
  ADD CONSTRAINT "anchored_link_anchor_one_target_check"
  CHECK (num_nonnulls("doc_id", "post_id", "file_id", "target_annotation_id", "target_comment_id") = 1);

ALTER TABLE "comment_quote_anchor"
  ADD CONSTRAINT "comment_quote_anchor_one_target_check"
  CHECK (num_nonnulls("doc_id", "post_id", "file_id", "target_annotation_id", "target_comment_id") = 1);

-- The part columns are all-or-nothing, the other two tables' twin. Every row
-- the Phase 3 writer produces has them non-null — a quotation of a *whole*
-- object is not a quotation — but the CHECK states the row shape, not the
-- writer's habit.
ALTER TABLE "comment_quote_anchor"
  ADD CONSTRAINT "comment_quote_anchor_selector_columns_check"
  CHECK (("selector_kind" IS NULL)
    = ("anchor_from" IS NULL AND "anchor_to" IS NULL AND "selector" IS NULL));

-- PLAN.md §23d — one stamp per substrate, so at most one of the three is set.
-- A PDF anchor has none (its sha256 is its identity); every other kind has
-- exactly one, but "exactly" is the writer's rule, since the CHECK cannot
-- see which arc leg is set without restating the whole table.
ALTER TABLE "comment_quote_anchor"
  ADD CONSTRAINT "comment_quote_anchor_one_stamp_check"
  CHECK (num_nonnulls("ydoc_update_id", "anchored_event_id", "quoted_revision_id") <= 1);
