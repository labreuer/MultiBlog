-- CreateTable
CREATE TABLE "anchored_link" (
    "id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "minted_at" TIMESTAMP(3),
    "deleted_by_user_id" TEXT,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "anchored_link_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "anchored_link_anchor" (
    "id" TEXT NOT NULL,
    "link_id" TEXT NOT NULL,
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

    CONSTRAINT "anchored_link_anchor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "anchored_link_created_by_id_idx" ON "anchored_link"("created_by_id");

-- CreateIndex
CREATE INDEX "anchored_link_anchor_link_id_idx" ON "anchored_link_anchor"("link_id");

-- CreateIndex
CREATE INDEX "anchored_link_anchor_doc_id_idx" ON "anchored_link_anchor"("doc_id");

-- CreateIndex
CREATE INDEX "anchored_link_anchor_post_id_idx" ON "anchored_link_anchor"("post_id");

-- CreateIndex
CREATE INDEX "anchored_link_anchor_file_id_idx" ON "anchored_link_anchor"("file_id");

-- CreateIndex
CREATE INDEX "anchored_link_anchor_target_annotation_id_idx" ON "anchored_link_anchor"("target_annotation_id");

-- AddForeignKey
ALTER TABLE "anchored_link" ADD CONSTRAINT "anchored_link_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "anchored_link" ADD CONSTRAINT "anchored_link_deleted_by_user_id_fkey" FOREIGN KEY ("deleted_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "anchored_link_anchor" ADD CONSTRAINT "anchored_link_anchor_link_id_fkey" FOREIGN KEY ("link_id") REFERENCES "anchored_link"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "anchored_link_anchor" ADD CONSTRAINT "anchored_link_anchor_doc_id_fkey" FOREIGN KEY ("doc_id") REFERENCES "doc"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "anchored_link_anchor" ADD CONSTRAINT "anchored_link_anchor_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "anchored_link_anchor" ADD CONSTRAINT "anchored_link_anchor_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "file"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "anchored_link_anchor" ADD CONSTRAINT "anchored_link_anchor_target_annotation_id_fkey" FOREIGN KEY ("target_annotation_id") REFERENCES "annotation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "anchored_link_anchor" ADD CONSTRAINT "anchored_link_anchor_anchored_event_id_fkey" FOREIGN KEY ("anchored_event_id") REFERENCES "post_publication_event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Hand-written below this line (the add_tags convention — appended to the
-- --create-only SQL before first apply; Prisma has no CHECK or partial-index
-- DSL). docs/ANCHORED_LINKS.md Increment 1.

-- The §20a object arc: exactly one target FK non-null, same constraint and
-- same reasoning as tag_anchor_one_target_check.
ALTER TABLE "anchored_link_anchor"
  ADD CONSTRAINT "anchored_link_anchor_one_target_check"
  CHECK (num_nonnulls("doc_id", "post_id", "file_id", "target_annotation_id") = 1);

-- The part columns are all-or-nothing (tag_anchor_selector_columns_check's
-- twin) — though unlike tag_anchor, every row this table's writer produces
-- has them non-null: a selector-less anchored_link_anchor would be a link to
-- a whole object, which is what an ordinary href already is.
ALTER TABLE "anchored_link_anchor"
  ADD CONSTRAINT "anchored_link_anchor_selector_columns_check"
  CHECK (("selector_kind" IS NULL)
    = ("anchor_from" IS NULL AND "anchor_to" IS NULL AND "selector" IS NULL));

-- One open draft per user: makes loadMyDraftLink a definite article and the
-- get-or-create race a catchable P2002.
CREATE UNIQUE INDEX "anchored_link_one_draft_per_user"
  ON "anchored_link" ("created_by_id")
  WHERE "minted_at" IS NULL AND "deleted_at" IS NULL;
