-- docs/PDF.md §13, "Versions" — an anchor names its version **exactly when**
-- it holds a PDF target: an annotation's `pdf_target`, or a `PDF_TEXT`
-- selector in an anchor table. The columns and their keys came with
-- `file_versions`; this is the CHECK, which could not be added there, since
-- the anchor writes of that build did not stamp the column.
--
-- Hand-written: Prisma has no DSL for a CHECK, as with the anchor tables'
-- own (`*_one_target_check`, `*_selector_columns_check`).

-- The fill again, for a row written between the two migrations. No file can
-- have a second version before either has run, so a row with a target and no
-- version is on its file's version 1 (which, for a migrated file, has the
-- file's own id). A version on a row with no target is cleared.
UPDATE "annotation" a SET "file_version_id" = v."id"
    FROM "file_version" v
    WHERE v."file_id" = a."file_id" AND v."number" = 1
      AND a."pdf_target" IS NOT NULL AND a."file_version_id" IS NULL;
UPDATE "tag_anchor" a SET "file_version_id" = v."id"
    FROM "file_version" v
    WHERE v."file_id" = a."file_id" AND v."number" = 1
      AND a."selector_kind" = 'PDF_TEXT' AND a."file_version_id" IS NULL;
UPDATE "anchored_link_anchor" a SET "file_version_id" = v."id"
    FROM "file_version" v
    WHERE v."file_id" = a."file_id" AND v."number" = 1
      AND a."selector_kind" = 'PDF_TEXT' AND a."file_version_id" IS NULL;
UPDATE "comment_quote_anchor" a SET "file_version_id" = v."id"
    FROM "file_version" v
    WHERE v."file_id" = a."file_id" AND v."number" = 1
      AND a."selector_kind" = 'PDF_TEXT' AND a."file_version_id" IS NULL;

UPDATE "annotation" SET "file_version_id" = NULL
    WHERE "pdf_target" IS NULL AND "file_version_id" IS NOT NULL;
UPDATE "tag_anchor" SET "file_version_id" = NULL
    WHERE "selector_kind" IS DISTINCT FROM 'PDF_TEXT' AND "file_version_id" IS NOT NULL;
UPDATE "anchored_link_anchor" SET "file_version_id" = NULL
    WHERE "selector_kind" IS DISTINCT FROM 'PDF_TEXT' AND "file_version_id" IS NOT NULL;
UPDATE "comment_quote_anchor" SET "file_version_id" = NULL
    WHERE "selector_kind" IS DISTINCT FROM 'PDF_TEXT' AND "file_version_id" IS NOT NULL;

-- Two halves, each needed. The first is "exactly when". The second is what
-- the pair key cannot say: a foreign key with a NULL column is not checked
-- at all, so a version beside a NULL `file_id` would name no file's version.
-- `IS NOT DISTINCT FROM`, since `selector_kind = 'PDF_TEXT'` is NULL for a
-- whole-object row, and a CHECK passes on NULL.
ALTER TABLE "annotation" ADD CONSTRAINT "annotation_file_version_check" CHECK (
    ("file_version_id" IS NOT NULL) = ("pdf_target" IS NOT NULL)
    AND ("file_version_id" IS NULL OR "file_id" IS NOT NULL)
);
ALTER TABLE "tag_anchor" ADD CONSTRAINT "tag_anchor_file_version_check" CHECK (
    ("file_version_id" IS NOT NULL) = ("selector_kind" IS NOT DISTINCT FROM 'PDF_TEXT'::"selector_kind")
    AND ("file_version_id" IS NULL OR "file_id" IS NOT NULL)
);
ALTER TABLE "anchored_link_anchor" ADD CONSTRAINT "anchored_link_anchor_file_version_check" CHECK (
    ("file_version_id" IS NOT NULL) = ("selector_kind" IS NOT DISTINCT FROM 'PDF_TEXT'::"selector_kind")
    AND ("file_version_id" IS NULL OR "file_id" IS NOT NULL)
);
ALTER TABLE "comment_quote_anchor" ADD CONSTRAINT "comment_quote_anchor_file_version_check" CHECK (
    ("file_version_id" IS NOT NULL) = ("selector_kind" IS NOT DISTINCT FROM 'PDF_TEXT'::"selector_kind")
    AND ("file_version_id" IS NULL OR "file_id" IS NOT NULL)
);
