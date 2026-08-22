-- "Author" was the wrong word for a file (PLAN.md §19). The people listed
-- against an uploaded PDF didn't write it: the list is seeded with whoever
-- uploaded it, is editable afterwards, and what it grants is control over the
-- file plus read access to a PRIVATE one — ownership, not authorship.
-- DocAuthor/PostAuthor are untouched: a doc's or post's listed users really
-- did write the thing.
--
-- Written by hand rather than by `migrate dev`, which diffs a renamed table as
-- DROP + CREATE and would have thrown away every row. RENAMEs preserve the
-- data, the primary key and both foreign keys; the constraint and index names
-- are renamed alongside so a later `migrate diff` sees no drift.
ALTER TABLE "file_author" RENAME TO "file_owner";
ALTER TABLE "file_owner" RENAME COLUMN "byline_order" TO "owner_order";
ALTER INDEX "file_author_pkey" RENAME TO "file_owner_pkey";
ALTER TABLE "file_owner" RENAME CONSTRAINT "file_author_file_id_fkey" TO "file_owner_file_id_fkey";
ALTER TABLE "file_owner" RENAME CONSTRAINT "file_author_user_id_fkey" TO "file_owner_user_id_fkey";
-- Postgres 18 catalogues NOT NULL as named constraints, and a column rename
-- does not rename them. Renamed so this database matches one built from
-- scratch by `migrate deploy`, where Postgres would derive these names itself.
ALTER TABLE "file_owner" RENAME CONSTRAINT "file_author_file_id_not_null" TO "file_owner_file_id_not_null";
ALTER TABLE "file_owner" RENAME CONSTRAINT "file_author_user_id_not_null" TO "file_owner_user_id_not_null";
ALTER TABLE "file_owner" RENAME CONSTRAINT "file_author_byline_order_not_null" TO "file_owner_owner_order_not_null";

-- The view follows the table by OID, so the rename above didn't break it — but
-- its output column is still called `byline`, and a view's column cannot be
-- renamed in place alongside a body change. Dropped and recreated, identical
-- to add_file_model's definition except for the vocabulary. Every rule that
-- shaped it still applies and is restated here rather than left in the older
-- file, since this is now the definition in force.
--
-- Never references `file`: Prisma emits a LEFT JOIN back to the base table when
-- ordering through a to-one relation, and Postgres 18's self-join elimination
-- only collapses INNER joins, so a view that read `file` would make every sort
-- through it scan that table twice (see add_doc_metrics_view).
--
-- FULL OUTER JOIN, not LEFT, because either side can exist without the other:
-- a file with annotations but no owner, or an owner with no annotations yet.
--
-- annotation_count excludes DRAFT as well as soft-deleted rows. Soft-deleted is
-- obvious; DRAFT matters because a draft is invisible to everyone but its
-- author (PLAN.md §13d), and a count that moved when someone else opened a
-- composer would leak exactly what that rule hides.
--
-- COALESCE on the count (but not on owners) is what lets Prisma declare
-- annotationCount as a non-null Int while owners stays String?: a view's
-- columns carry no NOT NULL of their own, so the guarantee has to come from the
-- expression.
DROP VIEW "file_metrics";
CREATE VIEW file_metrics AS
SELECT COALESCE(owners.file_id, notes.file_id) AS file_id,
       owners.owners                           AS owners,
       COALESCE(notes.annotation_count, 0)     AS annotation_count
FROM (
    SELECT fo.file_id,
           string_agg(u.admin_initials, ', ' ORDER BY fo.owner_order) AS owners
    FROM file_owner fo
    JOIN "user" u ON u.id = fo.user_id
    GROUP BY fo.file_id
) owners
FULL OUTER JOIN (
    SELECT a.file_id,
           count(*)::int AS annotation_count
    FROM annotation a
    WHERE a.file_id IS NOT NULL
      AND a.deleted_at IS NULL
      AND a.status <> 'DRAFT'
    GROUP BY a.file_id
) notes ON notes.file_id = owners.file_id;
