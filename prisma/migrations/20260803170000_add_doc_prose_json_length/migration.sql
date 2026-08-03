-- Store a doc's character count on the row, maintained by a trigger, instead
-- of computing doc_length(prose_json) on every read (PLAN.md §16l).
--
-- WHY NOT COMPUTE IT PER QUERY. The obvious alternative is to put
-- doc_length(prose_json) in the doc_metrics view next to the byline, which
-- makes it sortable with no new column and no trigger. It was built that way
-- first and measured, and the numbers killed it: doc_length is a recursive
-- walk over the whole document, roughly 52µs per 1k characters on this
-- database (~2.1ms for a 40k-character doc, ~0.04ms for a 500-character one),
-- and a view recomputes per query. That lands the cost in two bad places:
--   - /docs computes it for the page's 25 docs on *every* load, sorted or
--     not — ~26ms per visit at a 20k-character average;
--   - sorting by Length has no WHERE to push down, so it walks *every doc in
--     the table*. At 1,000 docs averaging 20k characters that is ~1 second per
--     page load, growing with the corpus.
-- The write side, by contrast, pays one walk per debounced collab flush
-- (server/doc-cache.ts) — a millisecond or two, once, on a path that is
-- already doing far more work than that. Storing it is strictly less total
-- work unless docs are rewritten far more often than /docs is looked at.
--
-- WHY A TRIGGER AND NOT A GENERATED COLUMN. `GENERATED ALWAYS AS
-- (doc_length(prose_json)) STORED` is accepted by Postgres 18, has an
-- identical cost profile, and cannot drift — it is the better mechanism on
-- every axis except the one that matters here. Prisma reads and sorts such a
-- column correctly (verified), and `doc.create()` works because Prisma omits
-- unnamed columns from the INSERT. But `prisma migrate diff` reads the
-- GENERATED expression as a column default and emits
-- `ALTER COLUMN "prose_json_length" DROP DEFAULT` *forever* — every future
-- `migrate dev` would offer to strip the generated-ness. A plain integer
-- column plus a trigger diffs completely clean, because Migrate does not
-- introspect triggers at all. The trigger wins by being invisible.
--
-- The virtual form is not an option regardless: PG18 rejects a VIRTUAL
-- generated column whose expression calls a user-defined function.
--
-- NOT NULL DEFAULT 0 in one statement rather than the nullable-then-backfill
-- dance CLAUDE.md documents: that dance exists because `prisma migrate dev`
-- prompts interactively for how to fill a new required column, and nothing
-- prompts for a migration written by hand. Postgres 11+ stores a constant
-- default in the catalog rather than rewriting the table, so this is cheap
-- even on a large doc table; the real values land in the UPDATE below.
ALTER TABLE "doc" ADD COLUMN "prose_json_length" integer NOT NULL DEFAULT 0;

-- Backfill. Rows whose prose_json is NULL (created but never flushed by the
-- collab server) are already correct at 0 — that is what doc_length returns
-- for them, so they are skipped rather than rewritten.
UPDATE "doc" SET "prose_json_length" = doc_length("prose_json") WHERE "prose_json" IS NOT NULL;

-- BEFORE, not AFTER: assigning to NEW is how a BEFORE trigger writes the
-- column, and it costs no second UPDATE the way an AFTER trigger would.
CREATE OR REPLACE FUNCTION doc_sync_prose_json_length() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.prose_json_length := doc_length(NEW.prose_json);
  RETURN NEW;
END;
$$;

-- `UPDATE OF prose_json` narrows the trigger to statements that actually name
-- the body column, so the far more common writes — title, slug, visibility,
-- the soft-delete columns — don't pay the walk. The column list applies only
-- to UPDATE; INSERT always fires, which is what makes a freshly created doc
-- correct without relying on the DEFAULT.
--
-- This is the drift surface, and it is worth naming: unlike a generated
-- column, a trigger can be turned off (ALTER TABLE ... DISABLE TRIGGER, or a
-- COPY that bypasses it), and a bulk rewrite of prose_json under a disabled
-- trigger would leave prose_json_length silently wrong with nothing failing.
-- scripts/check-ydoc-integrity.ts gained a `length-cache` check for exactly
-- that; run it after anything that touches doc bodies in bulk.
CREATE TRIGGER doc_sync_prose_json_length
BEFORE INSERT OR UPDATE OF prose_json ON "doc"
FOR EACH ROW EXECUTE FUNCTION doc_sync_prose_json_length();
