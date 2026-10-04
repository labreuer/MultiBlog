-- docs/FULLTEXT.md §3 — full-text search over docs, posts, annotations,
-- comments and PDF pages, in Postgres.
--
-- Prisma generated the columns, the vocabulary table and the GIN indexes from
-- schema.prisma. Everything else here is hand-written, because Migrate has no
-- notion of it: the two extensions, the text search configuration, the SQL
-- functions, the triggers and the backfill. Migrate does not introspect any
-- of those, so none of them shows up as drift.
--
-- What each search_vector holds, and why a trigger rather than the app writes
-- it, is in FULLTEXT.md §3; the short form is that prose_json has several
-- writers (the collab cache, createDocWithContent, the importer's in-place
-- update) and a trigger covers all of them by construction — the reason
-- prose_json_length is a trigger too (add_doc_prose_json_length).


-- ---------------------------------------------------------------------------
-- The extensions
-- ---------------------------------------------------------------------------
--
-- Both are contrib modules and both are *trusted*: any role with CREATE on
-- the database may install them, so `prisma migrate deploy` needs no
-- superuser step on an instance whose role owns its database. A machine
-- without the contrib package fails here, including `migrate dev`'s shadow
-- database (Fedora: `postgresql-contrib`).

CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;


-- ---------------------------------------------------------------------------
-- The configuration
-- ---------------------------------------------------------------------------
--
-- Postgres's `english` with `unaccent` ahead of the stemmer, for the token
-- types that can carry accents (`word`, and the two hyphenated ones); the
-- ascii* types have nothing to fold. So "Godel" finds "Gödel" and "naive"
-- finds "naïve", in both directions, and ts_headline still marks the word as
-- written. `unaccent` is a filtering dictionary, which is what lets it hand
-- its output on to english_stem rather than ending the chain.
--
-- Every function below names this configuration schema-qualified, so none of
-- them depends on the search path to find it.

CREATE TEXT SEARCH CONFIGURATION public.english_unaccent (COPY = pg_catalog.english);
ALTER TEXT SEARCH CONFIGURATION public.english_unaccent
  ALTER MAPPING FOR hword, hword_part, word WITH public.unaccent, pg_catalog.english_stem;


-- ---------------------------------------------------------------------------
-- prose_text(jsonb): a ProseMirror document's text, in document order
-- ---------------------------------------------------------------------------
--
-- The text pieces within a block are joined directly, blocks are joined by a
-- newline, and a hardBreak becomes a newline. Order matters where doc_length's
-- walk could ignore it: phrase search and ranking read word positions, and
-- ts_headline reads the text itself.
--
-- The walk descends only through `content` arrays, carrying each node's
-- ordinal path (`{3,1,2}` is the second child of the first child of the third
-- block), and int[] comparison is element-wise, so ORDER BY path is document
-- order. A piece's block is its path minus the last step. Text lives only in
-- `text` leaves and only under textblocks in this schema, never in attrs or
-- marks, so nothing else needs visiting. NULL and a document with no text
-- both give ''.
--
-- Checked against every doc in the largest corpus: the result is exactly the
-- text leaves' characters plus one newline per block boundary and per
-- hardBreak. About 28 µs per thousand characters, 4.5 ms for the longest
-- doc (88k characters).
CREATE FUNCTION public.prose_text(doc jsonb) RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  WITH RECURSIVE nodes(node, path) AS (
    SELECT doc, ARRAY[]::integer[]
    UNION ALL
    SELECT child.node, nodes.path || child.ord::integer
    FROM nodes
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(nodes.node -> 'content') = 'array' THEN nodes.node -> 'content' ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS child(node, ord)
  ),
  pieces AS (
    SELECT path[1:cardinality(path) - 1] AS block,
           path,
           CASE WHEN node ->> 'type' = 'text' THEN node ->> 'text' ELSE E'\n' END AS piece
    FROM nodes
    WHERE (node ->> 'type' = 'text' AND jsonb_typeof(node -> 'text') = 'string')
       OR node ->> 'type' = 'hardBreak'
  ),
  blocks AS (
    SELECT block, string_agg(piece, '' ORDER BY path) AS text
    FROM pieces
    GROUP BY block
  )
  SELECT coalesce(string_agg(text, E'\n' ORDER BY block), '') FROM blocks;
$$;


-- ---------------------------------------------------------------------------
-- One named function per kind: what its search_vector should be
-- ---------------------------------------------------------------------------
--
-- The trigger and scripts/integrity/check-search-index.ts both call these, so
-- they cannot disagree about what the right vector is. Weights: A for a
-- title, B for an annotation's body and a file's name, D for body text — so a
-- word in a title outranks the same word in the body.

CREATE FUNCTION public.doc_search_vector(title text, prose_json jsonb) RETURNS tsvector
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT setweight(to_tsvector('public.english_unaccent', coalesce(title, '')), 'A')
      || setweight(to_tsvector('public.english_unaccent', public.prose_text(prose_json)), 'D');
$$;

-- A post's own prose_json: the published or scheduled version. A draft that
-- was never published has none, and is found by its title alone.
CREATE FUNCTION public.post_search_vector(title text, prose_json jsonb) RETURNS tsvector
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT setweight(to_tsvector('public.english_unaccent', coalesce(title, '')), 'A')
      || setweight(to_tsvector('public.english_unaccent', public.prose_text(prose_json)), 'D');
$$;

CREATE FUNCTION public.annotation_search_vector(body_text text, quoted_text text) RETURNS tsvector
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT setweight(to_tsvector('public.english_unaccent', coalesce(body_text, '')), 'B')
      || setweight(to_tsvector('public.english_unaccent', coalesce(quoted_text, '')), 'D');
$$;

CREATE FUNCTION public.comment_search_vector(body_text text) RETURNS tsvector
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT to_tsvector('public.english_unaccent', coalesce(body_text, ''));
$$;

-- The filename as uploaded, which often carries the author and year a title
-- leaves out.
CREATE FUNCTION public.file_search_vector(title text, filename text) RETURNS tsvector
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT setweight(to_tsvector('public.english_unaccent', coalesce(title, '')), 'A')
      || setweight(to_tsvector('public.english_unaccent', coalesce(filename, '')), 'B');
$$;

CREATE FUNCTION public.file_page_text_search_vector(text text) RETURNS tsvector
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT to_tsvector('public.english_unaccent', coalesce(text, ''));
$$;


-- ---------------------------------------------------------------------------
-- The columns
-- ---------------------------------------------------------------------------
--
-- Plain nullable columns that a BEFORE trigger owns, exactly
-- prose_json_length's pattern: the app never assigns them, and the client
-- never selects them (they are `Unsupported("tsvector")` in schema.prisma).

ALTER TABLE "annotation" ADD COLUMN "search_vector" tsvector;
ALTER TABLE "comment" ADD COLUMN "search_vector" tsvector;
ALTER TABLE "doc" ADD COLUMN "search_vector" tsvector;
ALTER TABLE "file" ADD COLUMN "search_vector" tsvector;
ALTER TABLE "file_page_text" ADD COLUMN "search_vector" tsvector;
ALTER TABLE "post" ADD COLUMN "search_vector" tsvector;


-- ---------------------------------------------------------------------------
-- The row triggers that keep each column current
-- ---------------------------------------------------------------------------
--
-- BEFORE, so assigning NEW is the write and costs no second UPDATE. Each
-- fires on INSERT, and on an UPDATE that names a column its vector reads, so
-- the far more common writes (status, visibility, the soft-delete pair) don't
-- pay for a vector.
--
-- Every trigger function is declared with SET search_path. A data-only load
-- from pg_dump runs with an empty search path, and a function that calls
-- another without a schema then fails mid-load; doc_sync_prose_json_length
-- does exactly that, and is given the same setting at the end of this file.
--
-- The drift surface is the one prose_json_length has: a trigger can be
-- disabled, and a write under a disabled trigger leaves a vector silently
-- wrong. check-search-index.ts is what notices, and a no-op UPDATE of a column
-- the trigger names is the repair.

CREATE FUNCTION public.doc_sync_search_vector() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  NEW.search_vector := doc_search_vector(NEW.title, NEW.prose_json);
  RETURN NEW;
END;
$$;
CREATE TRIGGER doc_sync_search_vector
BEFORE INSERT OR UPDATE OF title, prose_json ON "doc"
FOR EACH ROW EXECUTE FUNCTION public.doc_sync_search_vector();

CREATE FUNCTION public.post_sync_search_vector() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  NEW.search_vector := post_search_vector(NEW.title, NEW.prose_json);
  RETURN NEW;
END;
$$;
CREATE TRIGGER post_sync_search_vector
BEFORE INSERT OR UPDATE OF title, prose_json ON "post"
FOR EACH ROW EXECUTE FUNCTION public.post_sync_search_vector();

CREATE FUNCTION public.annotation_sync_search_vector() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  NEW.search_vector := annotation_search_vector(NEW.body_text, NEW.quoted_text);
  RETURN NEW;
END;
$$;
CREATE TRIGGER annotation_sync_search_vector
BEFORE INSERT OR UPDATE OF body_text, quoted_text ON "annotation"
FOR EACH ROW EXECUTE FUNCTION public.annotation_sync_search_vector();

CREATE FUNCTION public.comment_sync_search_vector() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  NEW.search_vector := comment_search_vector(NEW.body_text);
  RETURN NEW;
END;
$$;
CREATE TRIGGER comment_sync_search_vector
BEFORE INSERT OR UPDATE OF body_text ON "comment"
FOR EACH ROW EXECUTE FUNCTION public.comment_sync_search_vector();

CREATE FUNCTION public.file_sync_search_vector() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  NEW.search_vector := file_search_vector(NEW.title, NEW.filename);
  RETURN NEW;
END;
$$;
CREATE TRIGGER file_sync_search_vector
BEFORE INSERT OR UPDATE OF title, filename ON "file"
FOR EACH ROW EXECUTE FUNCTION public.file_sync_search_vector();

-- Page text is written once per (file, page, text version) and never
-- rewritten; the UPDATE arm is for the backfill and the integrity repair.
CREATE FUNCTION public.file_page_text_sync_search_vector() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  NEW.search_vector := file_page_text_search_vector(NEW.text);
  RETURN NEW;
END;
$$;
CREATE TRIGGER file_page_text_sync_search_vector
BEFORE INSERT OR UPDATE OF text ON "file_page_text"
FOR EACH ROW EXECUTE FUNCTION public.file_page_text_sync_search_vector();


-- ---------------------------------------------------------------------------
-- The vocabulary
-- ---------------------------------------------------------------------------
--
-- Every lexeme in any vector, for typo correction to pick candidates from by
-- trigram similarity (FULLTEXT.md §5). Fed by two statement-level AFTER
-- triggers per table, so a batch costs one insert: hundreds of PDF pages
-- extracted together, or the backfill below.
--
-- - On INSERT, the statement's lexemes.
-- - On UPDATE, the new rows' lexemes minus the old rows'. That misses
--   nothing, because every lexeme already in a stored vector is already in
--   the table — the invariant check-search-index.ts verifies.
--
-- Both insert **in lexeme order** with ON CONFLICT DO NOTHING. Without the
-- order, two saves inserting overlapping sets can deadlock on the key.
--
-- Two triggers per table rather than one, and neither with a column list:
-- Postgres refuses transition tables on a trigger for more than one event or
-- with a column list. So the UPDATE trigger runs on every UPDATE statement,
-- and is cheap when the vectors didn't change (0.5 ms for the longest doc),
-- because the difference is then empty.
--
-- The table never shrinks by itself; a lexeme whose last occurrence is gone
-- does no harm (schema.prisma's SearchLexeme says why), and
-- `check-search-index.ts --repair` rebuilds it from ts_stat.

CREATE TABLE "search_lexeme" (
    "lexeme" TEXT NOT NULL,

    CONSTRAINT "search_lexeme_pkey" PRIMARY KEY ("lexeme")
);

CREATE FUNCTION public.search_lexeme_from_inserted() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  INSERT INTO search_lexeme (lexeme)
  SELECT DISTINCT l.lexeme
  FROM new_rows
  CROSS JOIN LATERAL unnest(tsvector_to_array(new_rows.search_vector)) AS l(lexeme)
  ORDER BY l.lexeme
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END;
$$;

CREATE FUNCTION public.search_lexeme_from_updated() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  INSERT INTO search_lexeme (lexeme)
  SELECT added.lexeme
  FROM (
    SELECT unnest(tsvector_to_array(new_rows.search_vector)) FROM new_rows
    EXCEPT
    SELECT unnest(tsvector_to_array(old_rows.search_vector)) FROM old_rows
  ) AS added(lexeme)
  ORDER BY added.lexeme
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END;
$$;

CREATE TRIGGER doc_search_lexeme_insert AFTER INSERT ON "doc"
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.search_lexeme_from_inserted();
CREATE TRIGGER doc_search_lexeme_update AFTER UPDATE ON "doc"
REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.search_lexeme_from_updated();

CREATE TRIGGER post_search_lexeme_insert AFTER INSERT ON "post"
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.search_lexeme_from_inserted();
CREATE TRIGGER post_search_lexeme_update AFTER UPDATE ON "post"
REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.search_lexeme_from_updated();

CREATE TRIGGER annotation_search_lexeme_insert AFTER INSERT ON "annotation"
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.search_lexeme_from_inserted();
CREATE TRIGGER annotation_search_lexeme_update AFTER UPDATE ON "annotation"
REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.search_lexeme_from_updated();

CREATE TRIGGER comment_search_lexeme_insert AFTER INSERT ON "comment"
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.search_lexeme_from_inserted();
CREATE TRIGGER comment_search_lexeme_update AFTER UPDATE ON "comment"
REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.search_lexeme_from_updated();

CREATE TRIGGER file_search_lexeme_insert AFTER INSERT ON "file"
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.search_lexeme_from_inserted();
CREATE TRIGGER file_search_lexeme_update AFTER UPDATE ON "file"
REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.search_lexeme_from_updated();

CREATE TRIGGER file_page_text_search_lexeme_insert AFTER INSERT ON "file_page_text"
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.search_lexeme_from_inserted();
CREATE TRIGGER file_page_text_search_lexeme_update AFTER UPDATE ON "file_page_text"
REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.search_lexeme_from_updated();


-- ---------------------------------------------------------------------------
-- The backfill
-- ---------------------------------------------------------------------------
--
-- A no-op UPDATE of a column each row trigger names (DATABASE.md's repair
-- recipe), so each vector's definition is written once, in its function, and
-- the vocabulary triggers fill search_lexeme on the way. Raw SQL leaves
-- updated_at alone — Prisma sets @updatedAt on the client side — so no date
-- the search filters read moves. Under a second for the largest corpus.
--
-- Before the GIN indexes, which build faster over full columns than they
-- grow row by row.

UPDATE "doc" SET "title" = "title";
UPDATE "post" SET "title" = "title";
UPDATE "annotation" SET "body_text" = "body_text";
UPDATE "comment" SET "body_text" = "body_text";
UPDATE "file" SET "title" = "title";
UPDATE "file_page_text" SET "text" = "text";


-- ---------------------------------------------------------------------------
-- The indexes (as Prisma generated them)
-- ---------------------------------------------------------------------------

CREATE INDEX "annotation_search_vector_idx" ON "annotation" USING GIN ("search_vector");
CREATE INDEX "comment_search_vector_idx" ON "comment" USING GIN ("search_vector");
CREATE INDEX "doc_search_vector_idx" ON "doc" USING GIN ("search_vector");
CREATE INDEX "file_search_vector_idx" ON "file" USING GIN ("search_vector");
CREATE INDEX "file_page_text_search_vector_idx" ON "file_page_text" USING GIN ("search_vector");
CREATE INDEX "post_search_vector_idx" ON "post" USING GIN ("search_vector");
CREATE INDEX "search_lexeme_lexeme_idx" ON "search_lexeme" USING GIN ("lexeme" gin_trgm_ops);


-- ---------------------------------------------------------------------------
-- doc_sync_prose_json_length's search path
-- ---------------------------------------------------------------------------
--
-- It calls doc_length() without a schema, so a data-only load (empty search
-- path) fails on the first doc. The same setting as every trigger function
-- above; nothing else about it changes.

ALTER FUNCTION public.doc_sync_prose_json_length() SET search_path = public, pg_catalog;
