-- Drops Annotation.body (the old plain-text {text} column) now that every
-- existing row has been backfilled onto prose_json/body_text via
-- scripts/backfill-annotation-ydocs.ts (run and deleted, PLAN.md §13j Phase 1).
-- Hand-written rather than via `prisma migrate dev` because that command's
-- own destructive-column-drop confirmation prompt requires an interactive
-- terminal, which isn't available here; the backfill was verified against
-- the dev database before this migration was written.
ALTER TABLE "annotation" DROP COLUMN "body";
