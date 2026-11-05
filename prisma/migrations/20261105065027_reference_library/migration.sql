-- CreateEnum
CREATE TYPE "ReferenceIdentifierScheme" AS ENUM ('DOI', 'ISBN');

-- CreateTable
CREATE TABLE "reference" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "csl" JSONB NOT NULL,
    "short" TEXT,
    "file_id" TEXT,
    "created_by_id" TEXT NOT NULL,
    "updated_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_by_user_id" TEXT,
    "deleted_at" TIMESTAMP(3),
    "search_vector" tsvector,

    CONSTRAINT "reference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reference_identifier" (
    "id" TEXT NOT NULL,
    "reference_id" TEXT NOT NULL,
    "scheme" "ReferenceIdentifierScheme" NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "reference_identifier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reference_key_history" (
    "id" TEXT NOT NULL,
    "reference_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reference_key_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reference_key_key" ON "reference"("key");

-- CreateIndex
CREATE INDEX "reference_file_id_idx" ON "reference"("file_id");

-- CreateIndex
CREATE INDEX "reference_created_by_id_idx" ON "reference"("created_by_id");

-- CreateIndex
CREATE INDEX "reference_search_vector_idx" ON "reference" USING GIN ("search_vector");

-- CreateIndex
CREATE INDEX "reference_identifier_reference_id_idx" ON "reference_identifier"("reference_id");

-- CreateIndex
CREATE UNIQUE INDEX "reference_identifier_scheme_value_key" ON "reference_identifier"("scheme", "value");

-- CreateIndex
CREATE UNIQUE INDEX "reference_key_history_key_key" ON "reference_key_history"("key");

-- CreateIndex
CREATE INDEX "reference_key_history_reference_id_idx" ON "reference_key_history"("reference_id");

-- AddForeignKey
ALTER TABLE "reference" ADD CONSTRAINT "reference_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reference" ADD CONSTRAINT "reference_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "file"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reference_identifier" ADD CONSTRAINT "reference_identifier_reference_id_fkey" FOREIGN KEY ("reference_id") REFERENCES "reference"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reference_key_history" ADD CONSTRAINT "reference_key_history_reference_id_fkey" FOREIGN KEY ("reference_id") REFERENCES "reference"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- docs/CITATIONS.md, "Records" — the reference library's search vector: what
-- /references finds a work by, and what a `cited_title` or `cited_author`
-- search matches before it follows the citations (docs/FULLTEXT.md).
--
-- A: the key, the abbreviation and the title. B: the people. D: where and
-- when it appeared. The people are the authors and the editors, each as
-- every part of their name.
CREATE FUNCTION public.reference_people(csl jsonb) RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT coalesce(string_agg(concat_ws(' ', person ->> 'given', person ->> 'family', person ->> 'literal'), ' '), '')
  FROM jsonb_array_elements(
    CASE WHEN jsonb_typeof(csl -> 'author') = 'array' THEN csl -> 'author' ELSE '[]'::jsonb END
    || CASE WHEN jsonb_typeof(csl -> 'editor') = 'array' THEN csl -> 'editor' ELSE '[]'::jsonb END
  ) AS person;
$$;

CREATE FUNCTION public.reference_search_vector(key text, short text, csl jsonb) RETURNS tsvector
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT setweight(to_tsvector('public.english_unaccent', concat_ws(' ', key, short, csl ->> 'title')), 'A')
      || setweight(to_tsvector('public.english_unaccent', public.reference_people(csl)), 'B')
      || setweight(
           to_tsvector(
             'public.english_unaccent',
             concat_ws(' ', csl ->> 'container-title', csl ->> 'collection-title', csl ->> 'publisher', csl #>> '{issued,date-parts,0,0}')
           ),
           'D'
         );
$$;

-- Trigger-written, as every other search_vector is: never assigned to. Its
-- own search_path, since a data-only load runs with an empty one
-- (docs/DATABASE.md).
CREATE FUNCTION public.reference_sync_search_vector() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  NEW.search_vector := reference_search_vector(NEW.key, NEW.short, NEW.csl);
  RETURN NEW;
END;
$$;
CREATE TRIGGER reference_sync_search_vector
BEFORE INSERT OR UPDATE OF key, short, csl ON "reference"
FOR EACH ROW EXECUTE FUNCTION public.reference_sync_search_vector();
