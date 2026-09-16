-- AlterTable
ALTER TABLE "annotation" ADD COLUMN     "editing_since" TIMESTAMP(3);
ALTER TABLE "annotation" ADD COLUMN     "posted_at" TIMESTAMP(3);

-- Hand-written below this line (the add_anchored_links convention). PLAN.md §22e.

-- Backfill: `posted_at` for every annotation that has actually been posted.
--
-- An approximation, stated rather than hidden: nothing recorded the DRAFT ->
-- LIVE transition before this column existed (only RAISED stamps `raised_at`),
-- and the row's `created_at` is when the composer was opened. The two are
-- seconds apart in practice — a composer opens a DRAFT, the author types, they
-- click Post. The consequence is confined: this is what §22b's grace window is
-- measured from, so a backfilled row's window opened slightly earlier than it
-- really did.
--
-- DRAFT rows are deliberately excluded: a draft has not been posted, so there
-- is no moment readers could first have seen it. Soft-deleted rows are
-- included, for the reason the comment side's backfill gives: deletion is a
-- pair of columns, and a restored annotation needs its history.
--
-- The versions themselves are not here. A version is a `ydoc_snapshot` on the
-- body's own ydoc, and SQL cannot materialise one; version 1 for every posted
-- body that has none is written by `scripts/backfill-annotation-snapshots.ts`,
-- which runs after this migration.
UPDATE "annotation" SET "posted_at" = "created_at" WHERE "status" <> 'DRAFT' AND "posted_at" IS NULL;
