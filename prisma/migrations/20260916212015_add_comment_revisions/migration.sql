-- CreateTable
CREATE TABLE "comment_revision" (
    "id" TEXT NOT NULL,
    "comment_id" TEXT NOT NULL,
    "revision_no" INTEGER NOT NULL,
    "body" JSONB NOT NULL,
    "author_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comment_revision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "comment_revision_comment_id_revision_no_key" ON "comment_revision"("comment_id", "revision_no");

-- AddForeignKey
ALTER TABLE "comment_revision" ADD CONSTRAINT "comment_revision_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_revision" ADD CONSTRAINT "comment_revision_author_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Hand-written below this line (the add_anchored_links convention — appended
-- to the --create-only SQL before first apply). PLAN.md §22c.

-- Backfill: every comment that already exists gets its revision 1.
--
-- "Current body = as posted" is exactly true rather than an approximation,
-- because nothing has ever edited a comment: before §22c the only columns
-- written after creation were the moderation trio and the soft-delete pair
-- (src/app/actions/comments.ts). So `created_at` is the real posting time and
-- `body` is the real original text, and this is a record of what happened
-- rather than a guess standing in for one.
--
-- Soft-deleted comments are included deliberately. Deletion here is a pair of
-- columns, not a removal, and a restored comment needs its history intact.
--
-- author_user_id comes from the commenter's linked user, which is null for
-- every anonymous commenter — the one case §22c's column is nullable for.
-- `cuid()` has no SQL equivalent, so ids are gen_random_uuid() text: a
-- different shape from every cuid in the table, and deliberately so. These
-- rows were minted by a migration rather than by the application, and a
-- reader who notices the difference is seeing something true.
INSERT INTO "comment_revision" ("id", "comment_id", "revision_no", "body", "author_user_id", "created_at")
SELECT gen_random_uuid()::text, c."id", 1, c."body", cm."user_id", c."created_at"
  FROM "comment" c
  JOIN "commenter" cm ON cm."id" = c."commenter_id";

-- comment_revision is queried two ways and never scanned: newest-first for one
-- comment (the history view, and editComment reading the tail), and in bulk by
-- the integrity check. The unique index above already serves both — (comment_id,
-- revision_no) is a prefix match for the first and an ordered walk for the
-- second — so there is deliberately no second index here.
