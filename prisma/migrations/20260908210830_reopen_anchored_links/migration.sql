-- AlterTable
ALTER TABLE "anchored_link" ADD COLUMN     "edited_at" TIMESTAMP(3),
ADD COLUMN     "reopened_at" TIMESTAMP(3);

-- Hand-written below this line (the add_anchored_links convention — appended
-- to the --create-only SQL before first apply; Prisma has no CHECK or
-- partial-index DSL). docs/ANCHORED_LINKS.md, "Editing a minted link".

-- reopened_at means one thing: a *minted* link back in its creator's tray.
-- A draft is open by being unminted and never carries it, so "open" stays a
-- single predicate (below) rather than two columns that could disagree.
ALTER TABLE "anchored_link"
  ADD CONSTRAINT "anchored_link_reopened_only_when_minted_check"
  CHECK ("reopened_at" IS NULL OR "minted_at" IS NOT NULL);

-- One open link per user, draft or reopened — the successor of
-- anchored_link_one_draft_per_user, whose predicate was the draft half of
-- this one. It is what makes loadMyOpenLink a definite article and the race
-- to open a second link (two tabs, or an add racing an Edit) a catchable
-- P2002. Minting and Done both free the slot; a soft delete clears
-- reopened_at as well, so a restore can never collide here.
DROP INDEX "anchored_link_one_draft_per_user";
CREATE UNIQUE INDEX "anchored_link_one_open_per_user"
  ON "anchored_link" ("created_by_id")
  WHERE ("minted_at" IS NULL OR "reopened_at" IS NOT NULL) AND "deleted_at" IS NULL;
