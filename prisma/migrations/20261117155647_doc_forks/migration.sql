-- AlterTable
ALTER TABLE "doc" ADD COLUMN     "forked_from_doc_id" TEXT,
ADD COLUMN     "forked_from_update_id" BIGINT;

-- AddForeignKey
ALTER TABLE "doc" ADD CONSTRAINT "doc_forked_from_doc_id_fkey" FOREIGN KEY ("forked_from_doc_id") REFERENCES "doc"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Hand-written below this line (the add_anchored_links convention — appended
-- to the --create-only SQL before first apply; Prisma has no syntax for a
-- CHECK or a partial index here). docs/FORKS.md, "Data model".

-- A fork records the parent's version it was copied at. The update id has no
-- foreign key, like every ydoc_update id column: the log is never truncated.
ALTER TABLE "doc" ADD CONSTRAINT "doc_fork_at_revision"
  CHECK ("forked_from_doc_id" IS NULL OR "forked_from_update_id" IS NOT NULL);
-- A doc's forks, for its family lines and the fork-point exception; partial,
-- since nearly every doc is no fork.
CREATE INDEX "doc_forked_from_idx" ON "doc" ("forked_from_doc_id")
  WHERE "forked_from_doc_id" IS NOT NULL;
