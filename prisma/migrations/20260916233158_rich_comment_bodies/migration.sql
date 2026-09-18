-- AlterTable
ALTER TABLE "comment" ADD COLUMN     "body_text" TEXT NOT NULL DEFAULT '';

-- Hand-written below this line (the add_anchored_links convention — appended
-- to the --create-only SQL before first apply). PLAN.md §23i.

-- `{ text }` becomes a ProseMirror document over pmCommentContentSchema, on
-- `comment` and on every `comment_revision`: one paragraph per non-empty line
-- of the old text, in order, so a comment that had line breaks keeps them as
-- paragraph breaks rather than as a newline collapsed inside one paragraph. A
-- body that was empty or whitespace-only becomes one empty paragraph — the
-- schema's content is `block+`, so an empty content array would fail
-- nodeFromJSON on the next read. `body_text` is the same lines joined with
-- newlines, which is exactly what `commentBodyText` derives from the new
-- document, so the integrity check passes on every backfilled row.
--
-- Guarded by `body ? 'text'` so the statement is idempotent on a row already
-- in the new shape (a `doc` node has no top-level `text` key).
CREATE OR REPLACE FUNCTION pg_temp.comment_lines_to_doc(src text)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'type', 'doc',
    'content', COALESCE(
      (SELECT jsonb_agg(
         jsonb_build_object('type', 'paragraph', 'content',
           jsonb_build_array(jsonb_build_object('type', 'text', 'text', line)))
         ORDER BY ord)
       FROM regexp_split_to_table(COALESCE(src, ''), E'\r?\n') WITH ORDINALITY AS t(line, ord)
       WHERE btrim(line) <> ''),
      jsonb_build_array(jsonb_build_object('type', 'paragraph'))))
$$;

CREATE OR REPLACE FUNCTION pg_temp.comment_lines_to_text(src text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(
    (SELECT string_agg(line, E'\n' ORDER BY ord)
     FROM regexp_split_to_table(COALESCE(src, ''), E'\r?\n') WITH ORDINALITY AS t(line, ord)
     WHERE btrim(line) <> ''),
    '')
$$;

UPDATE "comment"
   SET "body_text" = pg_temp.comment_lines_to_text("body"->>'text'),
       "body"      = pg_temp.comment_lines_to_doc("body"->>'text')
 WHERE "body" ? 'text';

UPDATE "comment_revision"
   SET "body" = pg_temp.comment_lines_to_doc("body"->>'text')
 WHERE "body" ? 'text';
