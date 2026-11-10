-- docs/CITATIONS.md, "Keys" and "What a record keeps".
--
-- 1. `key_folded` on `reference` and `reference_key_history`: the key with
--    A to Z lowercased and nothing else, which every lookup by key reads, so
--    a key keeps the case its source gave it and is found in any case. Held
--    to the key by a CHECK written with `translate`, the same rule as the
--    code's `foldKey`: `lower()` follows the database's locale, and it and
--    `toLowerCase()` disagree on letters an alias may hold (`İ`, a final
--    `Σ`), so a CHECK on `lower()` would refuse an alias the code had folded.
--    Uniquely indexed, which an index on `lower(key)` would be too, but
--    Prisma can't read an index on an expression through `findUnique`.
ALTER TABLE "reference" ADD COLUMN "key_folded" TEXT;
UPDATE "reference" SET "key_folded" = translate("key", 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz');
ALTER TABLE "reference" ALTER COLUMN "key_folded" SET NOT NULL;
ALTER TABLE "reference" ADD CONSTRAINT "reference_key_folded_check"
  CHECK ("key_folded" = translate("key", 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'));
CREATE UNIQUE INDEX "reference_key_folded_key" ON "reference"("key_folded");

ALTER TABLE "reference_key_history" ADD COLUMN "key_folded" TEXT;
UPDATE "reference_key_history" SET "key_folded" = translate("key", 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz');
ALTER TABLE "reference_key_history" ALTER COLUMN "key_folded" SET NOT NULL;
ALTER TABLE "reference_key_history" ADD CONSTRAINT "reference_key_history_key_folded_check"
  CHECK ("key_folded" = translate("key", 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'));
CREATE UNIQUE INDEX "reference_key_history_key_folded_key" ON "reference_key_history"("key_folded");

-- 2. A title's text, its markup taken out: what the listing shows and sorts
--    by and what the search vector reads. A record's three title fields keep
--    CSL-JSON's tags (`<i>`, `<b>`, `<sup>`, `<sub>`, a `<span>`), and a tag
--    is a `<`, a `/` or not, and a letter, up to the next `>`, as
--    src/lib/references/markup.ts reads one. Character references were
--    decoded before the record was stored, so there are none to decode.
CREATE FUNCTION public.reference_title_text(title text) RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT regexp_replace(title, '</?[A-Za-z][A-Za-z0-9]*[^>]*>', '', 'g');
$$;

-- 3. A family name as every use of a name reads it, its non-dropping
--    particle first ("van Beethoven"), joined with a space unless the
--    particle ends in an apostrophe or a hyphen ("d'Alembert"), as
--    `withParticle` joins it.
CREATE FUNCTION public.reference_family(person jsonb) RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN person ->> 'family' IS NULL THEN NULL
    WHEN coalesce(person ->> 'non-dropping-particle', '') = '' THEN person ->> 'family'
    WHEN person ->> 'non-dropping-particle' ~ '[''’-]$' THEN (person ->> 'non-dropping-particle') || (person ->> 'family')
    ELSE (person ->> 'non-dropping-particle') || ' ' || (person ->> 'family')
  END;
$$;

-- The people the search vector reads: every part of each name, both
-- particles and the suffix included.
CREATE OR REPLACE FUNCTION public.reference_people(csl jsonb) RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT coalesce(string_agg(concat_ws(' ',
           person ->> 'given', person ->> 'dropping-particle', person ->> 'non-dropping-particle',
           person ->> 'family', person ->> 'suffix', person ->> 'literal'), ' '), '')
  FROM jsonb_array_elements(
    CASE WHEN jsonb_typeof(csl -> 'author') = 'array' THEN csl -> 'author' ELSE '[]'::jsonb END
    || CASE WHEN jsonb_typeof(csl -> 'editor') = 'array' THEN csl -> 'editor' ELSE '[]'::jsonb END
  ) AS person;
$$;

-- 4. The search vector reads the key with every character but a letter or a
--    digit as a space: Postgres reads `smith.jones-2012` as a host name and a
--    number, while a search sends the words `smith`, `jones` and `2012`. And
--    it reads the titles' text, not their tags.
CREATE OR REPLACE FUNCTION public.reference_search_vector(key text, short text, csl jsonb) RETURNS tsvector
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT setweight(
           to_tsvector('public.english_unaccent', concat_ws(' ', regexp_replace(key, '[^[:alnum:]]+', ' ', 'g'), short, public.reference_title_text(csl ->> 'title'))),
           'A'
         )
      || setweight(to_tsvector('public.english_unaccent', public.reference_people(csl)), 'B')
      || setweight(
           to_tsvector(
             'public.english_unaccent',
             concat_ws(' ', public.reference_title_text(csl ->> 'container-title'), public.reference_title_text(csl ->> 'collection-title'), csl ->> 'publisher', csl #>> '{issued,date-parts,0,0}')
           ),
           'D'
         );
$$;

-- The trigger function names its search path, and these functions are found
-- through it; the vector is rewritten for every row, since its key and
-- title words change.
UPDATE "reference" SET "csl" = "csl";

-- 5. The listing: a title's text, and each name as "Family Given", its
--    non-dropping particle in the family name so it sorts under V, then the
--    dropping particle and the suffix.
CREATE OR REPLACE VIEW reference_listing AS
SELECT
  r.id AS reference_id,
  public.reference_title_text(r.csl ->> 'title') AS title,
  (
    SELECT string_agg(concat_ws(' ', public.reference_family(person), person ->> 'literal', person ->> 'given', person ->> 'dropping-particle', person ->> 'suffix'), '; ' ORDER BY ord)
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(r.csl -> 'author') = 'array' THEN r.csl -> 'author' ELSE '[]'::jsonb END
      || CASE WHEN jsonb_typeof(r.csl -> 'editor') = 'array' THEN r.csl -> 'editor' ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS people(person, ord)
  ) AS people,
  CASE WHEN r.csl #>> '{issued,date-parts,0,0}' ~ '^[0-9]{1,4}$' THEN (r.csl #>> '{issued,date-parts,0,0}')::integer END AS year
FROM "reference" r;
