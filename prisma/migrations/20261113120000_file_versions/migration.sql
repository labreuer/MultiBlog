-- docs/PDF.md §13, "Versions" — a file's bytes become its *versions*.
--
-- What the bytes decide (hash, size, type, page count, labels, outline and
-- the uploaded filename) moves from `file` to a `file_version` row, and
-- `file.current_version_id` names the latest. Every file that exists gets a
-- version 1, promoted, made from its own `created_*` values.
--
-- **A migrated version 1 takes its file's id as its own.** That is what lets
-- `file_page_text` be re-keyed by renaming its column, with no row rewritten,
-- and an anchor's version be filled from its `file_id`. A version made after
-- this migration has an id of its own.
--
-- Hand-written throughout: `migrate dev` would drop the seven columns and
-- add them empty.

-- ---------------------------------------------------------------------------
-- 1. The table, and a version 1 for every file
-- ---------------------------------------------------------------------------

CREATE TABLE "file_version" (
    "id" TEXT NOT NULL,
    "file_id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "filename" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "page_count" INTEGER,
    "page_labels" JSONB,
    "outline" JSONB,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploaded_by_user_id" TEXT,
    "promoted_at" TIMESTAMP(3),
    "promoted_by_user_id" TEXT,
    "abandoned_at" TIMESTAMP(3),
    "base_version_id" TEXT,
    "uploaded_at_update_id" BIGINT NOT NULL,
    "promoted_at_update_id" BIGINT,

    CONSTRAINT "file_version_pkey" PRIMARY KEY ("id")
);

-- Both update ids are the highest `ydoc_update.id` written no later than the
-- file was, 0 where the log held nothing by then: the clock a link is dated
-- against ("Links into the file"). One pass over the log per file, which is
-- seconds on the largest instance and runs once.
INSERT INTO "file_version" (
    "id", "file_id", "number", "filename", "content_type", "byte_size", "sha256",
    "page_count", "page_labels", "outline",
    "uploaded_at", "uploaded_by_user_id", "promoted_at", "promoted_by_user_id",
    "uploaded_at_update_id", "promoted_at_update_id"
)
SELECT
    f."id", f."id", 1, f."filename", f."content_type", f."byte_size", f."sha256",
    f."page_count", f."page_labels", f."outline",
    f."created_at", f."created_by_user_id", f."created_at", f."created_by_user_id",
    mark."update_id", mark."update_id"
FROM "file" f
CROSS JOIN LATERAL (
    SELECT COALESCE(max(u."id"), 0) AS "update_id"
    FROM "ydoc_update" u
    WHERE u."created_at" <= f."created_at"
) mark;

CREATE UNIQUE INDEX "file_version_file_id_number_key" ON "file_version"("file_id", "number");
-- The target of every pair key below.
CREATE UNIQUE INDEX "file_version_id_file_id_key" ON "file_version"("id", "file_id");
CREATE INDEX "file_version_sha256_idx" ON "file_version"("sha256");
-- One candidate per file: a version neither promoted nor abandoned. Prisma
-- has no DSL for a partial index, as with `file_slug_live_key`.
CREATE UNIQUE INDEX "file_version_one_candidate_key" ON "file_version"("file_id")
    WHERE "promoted_at" IS NULL AND "abandoned_at" IS NULL;

ALTER TABLE "file_version" ADD CONSTRAINT "file_version_file_id_fkey"
    FOREIGN KEY ("file_id") REFERENCES "file"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "file_version" ADD CONSTRAINT "file_version_uploaded_by_user_id_fkey"
    FOREIGN KEY ("uploaded_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "file_version" ADD CONSTRAINT "file_version_promoted_by_user_id_fkey"
    FOREIGN KEY ("promoted_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "file_version" ADD CONSTRAINT "file_version_base_version_id_fkey"
    FOREIGN KEY ("base_version_id") REFERENCES "file_version"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 2. The pointer, and the search trigger that reads the filename through it
-- ---------------------------------------------------------------------------

ALTER TABLE "file" ADD COLUMN "current_version_id" TEXT;

-- The trigger's column list names `filename`, so it goes before the column
-- can. Replaced before the pointer is filled, so that fill computes each
-- vector from the version's filename: the same two strings as before, and
-- so the same vector.
DROP TRIGGER file_sync_search_vector ON "file";

-- The filename is the latest version's. On a file's INSERT there is no
-- version yet (the two rows name each other, and the file is written first),
-- so the vector then holds the title alone, and the UPDATE that sets the
-- pointer is what puts the filename in. A promotion fires it the same way.
CREATE OR REPLACE FUNCTION public.file_sync_search_vector() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  NEW.search_vector := file_search_vector(
    NEW.title,
    (SELECT v.filename FROM file_version v WHERE v.id = NEW.current_version_id)
  );
  RETURN NEW;
END;
$$;
CREATE TRIGGER file_sync_search_vector
BEFORE INSERT OR UPDATE OF title, current_version_id ON "file"
FOR EACH ROW EXECUTE FUNCTION public.file_sync_search_vector();

UPDATE "file" SET "current_version_id" = "id";

DROP INDEX "file_sha256_idx";
ALTER TABLE "file"
    DROP COLUMN "filename",
    DROP COLUMN "content_type",
    DROP COLUMN "byte_size",
    DROP COLUMN "sha256",
    DROP COLUMN "page_count",
    DROP COLUMN "page_labels",
    DROP COLUMN "outline";

-- The pair is what makes the latest one of the file's own versions, and the
-- unique index is what lets Prisma take the pair as a one-to-one relation.
-- NO ACTION: SET NULL on a pair would null `id` too.
CREATE UNIQUE INDEX "file_current_version_id_id_key" ON "file"("current_version_id", "id");
ALTER TABLE "file" ADD CONSTRAINT "file_current_version_id_id_fkey"
    FOREIGN KEY ("current_version_id", "id") REFERENCES "file_version"("id", "file_id")
    ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- 3. Page text, keyed by version
-- ---------------------------------------------------------------------------

ALTER TABLE "file_page_text" DROP CONSTRAINT "file_page_text_file_id_fkey";
ALTER TABLE "file_page_text" RENAME COLUMN "file_id" TO "file_version_id";
ALTER TABLE "file_page_text" ADD CONSTRAINT "file_page_text_file_version_id_fkey"
    FOREIGN KEY ("file_version_id") REFERENCES "file_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 4. An anchor names its version
-- ---------------------------------------------------------------------------
--
-- Set exactly when the row holds a PDF target, a `pdf_target` or a `PDF_TEXT`
-- selector. The CHECK that says so is the next migration's, once every write
-- stamps it. Each key is on the pair, so the version is one of that file's,
-- and NO ACTION: a version's row goes only with its file, whose own cascade
-- takes the anchors.

ALTER TABLE "annotation" ADD COLUMN "file_version_id" TEXT;
ALTER TABLE "tag_anchor" ADD COLUMN "file_version_id" TEXT;
ALTER TABLE "anchored_link_anchor" ADD COLUMN "file_version_id" TEXT;
ALTER TABLE "comment_quote_anchor" ADD COLUMN "file_version_id" TEXT;

UPDATE "annotation" SET "file_version_id" = "file_id"
    WHERE "pdf_target" IS NOT NULL AND "file_id" IS NOT NULL;
UPDATE "tag_anchor" SET "file_version_id" = "file_id"
    WHERE "selector_kind" = 'PDF_TEXT' AND "file_id" IS NOT NULL;
UPDATE "anchored_link_anchor" SET "file_version_id" = "file_id"
    WHERE "selector_kind" = 'PDF_TEXT' AND "file_id" IS NOT NULL;
UPDATE "comment_quote_anchor" SET "file_version_id" = "file_id"
    WHERE "selector_kind" = 'PDF_TEXT' AND "file_id" IS NOT NULL;

CREATE INDEX "annotation_file_version_id_idx" ON "annotation"("file_version_id");
CREATE INDEX "tag_anchor_file_version_id_idx" ON "tag_anchor"("file_version_id");
CREATE INDEX "anchored_link_anchor_file_version_id_idx" ON "anchored_link_anchor"("file_version_id");
CREATE INDEX "comment_quote_anchor_file_version_id_idx" ON "comment_quote_anchor"("file_version_id");

ALTER TABLE "annotation" ADD CONSTRAINT "annotation_file_version_id_file_id_fkey"
    FOREIGN KEY ("file_version_id", "file_id") REFERENCES "file_version"("id", "file_id")
    ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "tag_anchor" ADD CONSTRAINT "tag_anchor_file_version_id_file_id_fkey"
    FOREIGN KEY ("file_version_id", "file_id") REFERENCES "file_version"("id", "file_id")
    ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "anchored_link_anchor" ADD CONSTRAINT "anchored_link_anchor_file_version_id_file_id_fkey"
    FOREIGN KEY ("file_version_id", "file_id") REFERENCES "file_version"("id", "file_id")
    ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "comment_quote_anchor" ADD CONSTRAINT "comment_quote_anchor_file_version_id_file_id_fkey"
    FOREIGN KEY ("file_version_id", "file_id") REFERENCES "file_version"("id", "file_id")
    ON DELETE NO ACTION ON UPDATE NO ACTION;
