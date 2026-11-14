-- docs/PDF.md §13, "Moving a note forward" — the history of moves, and the
-- "stays here" marks.
--
-- A move gave an anchor on one version of a file a target on a later one.
-- Its row keeps the three things the move changed on the anchor, as they
-- were: its version, its target and its quote. A mark is a row that reaches
-- no version. An anchor's newest move is by `id`, which is from a sequence.
--
-- Empty when this runs: nothing has moved a note or marked one before it.

-- CreateTable
CREATE TABLE "file_anchor_move" (
    "id" BIGSERIAL NOT NULL,
    "annotation_id" TEXT,
    "anchored_link_anchor_id" TEXT,
    "from_version_id" TEXT NOT NULL,
    "from_target" JSONB,
    "from_quoted_text" TEXT NOT NULL DEFAULT '',
    "to_version_id" TEXT,
    "moved_by_user_id" TEXT,
    "moved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "carry_id" TEXT,
    "was_marked" BOOLEAN NOT NULL DEFAULT false,
    "hidden" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "file_anchor_move_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "file_anchor_move_annotation_id_idx" ON "file_anchor_move"("annotation_id");

-- CreateIndex
CREATE INDEX "file_anchor_move_anchored_link_anchor_id_idx" ON "file_anchor_move"("anchored_link_anchor_id");

-- CreateIndex
CREATE INDEX "file_anchor_move_from_version_id_idx" ON "file_anchor_move"("from_version_id");

-- CreateIndex
CREATE INDEX "file_anchor_move_to_version_id_idx" ON "file_anchor_move"("to_version_id");

-- CreateIndex
CREATE INDEX "file_anchor_move_carry_id_idx" ON "file_anchor_move"("carry_id");

-- AddForeignKey
ALTER TABLE "file_anchor_move" ADD CONSTRAINT "file_anchor_move_annotation_id_fkey" FOREIGN KEY ("annotation_id") REFERENCES "annotation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_anchor_move" ADD CONSTRAINT "file_anchor_move_anchored_link_anchor_id_fkey" FOREIGN KEY ("anchored_link_anchor_id") REFERENCES "anchored_link_anchor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_anchor_move" ADD CONSTRAINT "file_anchor_move_from_version_id_fkey" FOREIGN KEY ("from_version_id") REFERENCES "file_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_anchor_move" ADD CONSTRAINT "file_anchor_move_to_version_id_fkey" FOREIGN KEY ("to_version_id") REFERENCES "file_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_anchor_move" ADD CONSTRAINT "file_anchor_move_moved_by_user_id_fkey" FOREIGN KEY ("moved_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Hand-written from here: Prisma has no DSL for a CHECK or a partial index.

-- The row moved is one of the two kinds of anchor, as each anchor table's
-- object side is one of its foreign keys.
ALTER TABLE "file_anchor_move" ADD CONSTRAINT "file_anchor_move_anchor_check"
    CHECK (num_nonnulls("annotation_id", "anchored_link_anchor_id") = 1);

-- A move keeps the target it left, and reaches another version than the one
-- it left. A mark keeps none: it is not hidden, is part of no carry, and
-- says nothing of an earlier mark.
ALTER TABLE "file_anchor_move" ADD CONSTRAINT "file_anchor_move_mark_check"
    CHECK (
      CASE WHEN "to_version_id" IS NULL
        THEN "from_target" IS NULL AND "from_quoted_text" = '' AND "carry_id" IS NULL AND NOT "was_marked" AND NOT "hidden"
        ELSE "from_target" IS NOT NULL AND "to_version_id" <> "from_version_id"
      END
    );

-- An anchor has one "stays here" mark at most.
CREATE UNIQUE INDEX "file_anchor_move_annotation_mark_key" ON "file_anchor_move"("annotation_id")
    WHERE "to_version_id" IS NULL AND "annotation_id" IS NOT NULL;
CREATE UNIQUE INDEX "file_anchor_move_anchored_link_anchor_mark_key" ON "file_anchor_move"("anchored_link_anchor_id")
    WHERE "to_version_id" IS NULL AND "anchored_link_anchor_id" IS NOT NULL;
