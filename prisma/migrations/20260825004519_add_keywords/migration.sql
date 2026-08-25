-- CreateEnum
CREATE TYPE "selector_kind" AS ENUM ('DOC_RANGE', 'PDF_TEXT');

-- CreateTable
CREATE TABLE "keyword" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_by_user_id" TEXT,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "keyword_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "keyword_assignment" (
    "id" TEXT NOT NULL,
    "keyword_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_by_user_id" TEXT,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "keyword_assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "keyword_anchor" (
    "id" TEXT NOT NULL,
    "assignment_id" TEXT NOT NULL,
    "doc_id" TEXT,
    "post_id" TEXT,
    "file_id" TEXT,
    "target_annotation_id" TEXT,
    "selector_kind" "selector_kind",
    "anchor_from" INTEGER,
    "anchor_to" INTEGER,
    "quoted_text" TEXT NOT NULL DEFAULT '',
    "selector" JSONB,
    "ydoc_update_id" BIGINT,
    "anchored_event_id" TEXT,
    "part_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "keyword_anchor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "keyword_slug_key" ON "keyword"("slug");

-- CreateIndex
CREATE INDEX "keyword_created_by_id_idx" ON "keyword"("created_by_id");

-- CreateIndex
CREATE INDEX "keyword_assignment_keyword_id_idx" ON "keyword_assignment"("keyword_id");

-- CreateIndex
CREATE INDEX "keyword_assignment_user_id_idx" ON "keyword_assignment"("user_id");

-- CreateIndex
CREATE INDEX "keyword_anchor_assignment_id_idx" ON "keyword_anchor"("assignment_id");

-- CreateIndex
CREATE INDEX "keyword_anchor_doc_id_idx" ON "keyword_anchor"("doc_id");

-- CreateIndex
CREATE INDEX "keyword_anchor_post_id_idx" ON "keyword_anchor"("post_id");

-- CreateIndex
CREATE INDEX "keyword_anchor_file_id_idx" ON "keyword_anchor"("file_id");

-- CreateIndex
CREATE INDEX "keyword_anchor_target_annotation_id_idx" ON "keyword_anchor"("target_annotation_id");

-- AddForeignKey
ALTER TABLE "keyword" ADD CONSTRAINT "keyword_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "keyword" ADD CONSTRAINT "keyword_deleted_by_user_id_fkey" FOREIGN KEY ("deleted_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "keyword_assignment" ADD CONSTRAINT "keyword_assignment_keyword_id_fkey" FOREIGN KEY ("keyword_id") REFERENCES "keyword"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "keyword_assignment" ADD CONSTRAINT "keyword_assignment_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "keyword_assignment" ADD CONSTRAINT "keyword_assignment_deleted_by_user_id_fkey" FOREIGN KEY ("deleted_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "keyword_anchor" ADD CONSTRAINT "keyword_anchor_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "keyword_assignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "keyword_anchor" ADD CONSTRAINT "keyword_anchor_doc_id_fkey" FOREIGN KEY ("doc_id") REFERENCES "doc"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "keyword_anchor" ADD CONSTRAINT "keyword_anchor_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "keyword_anchor" ADD CONSTRAINT "keyword_anchor_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "file"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "keyword_anchor" ADD CONSTRAINT "keyword_anchor_target_annotation_id_fkey" FOREIGN KEY ("target_annotation_id") REFERENCES "annotation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "keyword_anchor" ADD CONSTRAINT "keyword_anchor_anchored_event_id_fkey" FOREIGN KEY ("anchored_event_id") REFERENCES "post_publication_event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Appended by hand to the generated migration (Prisma emits neither CHECK
-- constraints nor case-insensitive expression indexes). Same technique
-- add_file_model and DocLink's mark_id/mark pair already use.

-- PLAN.md §20b — the object arc: exactly one of the four FKs is non-null.
-- Real FKs rather than a (type, id) pair because this schema leans hard on
-- cascades, and this is what makes "exactly one" a fact rather than a habit.
-- src/lib/anchors/target.ts is the application-side face of the same rule.
ALTER TABLE "keyword_anchor"
  ADD CONSTRAINT "keyword_anchor_one_target_check"
  CHECK (num_nonnulls("doc_id", "post_id", "file_id", "target_annotation_id") = 1);

-- PLAN.md §20b — the part columns are all-or-nothing, so shipping them before
-- their writer is honest rather than merely harmless (the way §14b's
-- num_nonnulls(mark_id, mark) made `mark_id` honest). PR 1 writes only
-- whole-object rows — every column named here stays NULL — and the constraint
-- is permanent either way.
--
-- Deliberately says nothing about ydoc_update_id or anchored_event_id: a stamp
-- without offsets is meaningless but harmless, and anchored_event_id has no
-- writer at all yet (§20i).
ALTER TABLE "keyword_anchor"
  ADD CONSTRAINT "keyword_anchor_selector_columns_check"
  CHECK (
    ("selector_kind" IS NULL)
    = ("anchor_from" IS NULL AND "anchor_to" IS NULL AND "selector" IS NULL)
  );

-- PLAN.md §20c — slug uniqueness alone would admit "Epistemology" and
-- "epistemology" as two distinct terms, which is a vocabulary bug rather than
-- a display one. Prisma has no expression-index DSL, so this lives here.
--
-- Deliberately **not** filtered on deleted_at: a soft-deleted term still holds
-- its name, exactly as a soft-deleted post still holds its slug, so that
-- reusing the name gives a friendly "already exists" from keywordNameInUse
-- rather than a raw P2002 at create time (src/lib/keyword-slug.ts).
CREATE UNIQUE INDEX "keyword_name_lower_key" ON "keyword" (lower("name"));
