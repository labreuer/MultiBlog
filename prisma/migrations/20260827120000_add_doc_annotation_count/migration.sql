-- /docs gains an Annotations column, so doc_metrics gains the count that sorts
-- it (PLAN.md §16e, §16l). The file side already carries the identical column
-- (file_metrics.annotation_count, add_pdf_annotations) and this is deliberately
-- its twin: the same filter, the same shape, the same nulls handling, so the
-- two admin tables answer "how much commentary is on this thing" the same way.
--
-- WHY THE VIEW AND NOT `_count`. Prisma orders a to-many relation by exactly
-- one thing, `_count`, and that count is unconditional. This one is filtered —
-- a soft-deleted annotation counts for nothing, and a DRAFT is a composer
-- nobody but its author can see (annotation-data.ts's getDocAnnotationsAsThreads
-- excludes another user's DRAFT rows outright), so counting one would show an
-- admin a number no reader could ever reach. `_count` cannot express either
-- exclusion in an orderBy, which is the whole reason there is a view column
-- here instead of an `include`.
--
-- REPLIES COUNT. A reply carries its parent's container id (createDraftAnnotation
-- refuses a reply whose parent lives elsewhere), so this is every live remark on
-- the doc rather than every thread on it. Same as file_metrics, and the honest
-- reading of the header: a doc with one root and nine replies has ten
-- annotations on it, not one.
--
-- WHY FULL OUTER JOIN. The previous form was a plain GROUP BY over doc_author,
-- which cannot carry a second aggregate keyed the same way: a doc can have
-- annotations and no authors, or authors and no annotations, and both still
-- need a row. This is the shape add_pdf_annotations reached for when
-- file_metrics grew the same column, arrived at from the same starting point.
--
-- WHAT IS PRESERVED. Neither branch reads `doc`. That is the point of
-- add_doc_metrics_view's shape and it survives intact — Prisma emits a LEFT
-- JOIN back to the base table for a to-one relation ordering, Postgres 18's
-- self-join elimination only collapses INNER joins, so a view that reads its
-- own base table gets that table scanned twice on every sort through it. The
-- annotation branch is served by annotation_doc_id_idx and touches doc no more
-- than the byline branch does.
--
-- WHAT CHANGES, AND IT IS ONE THING. `byline` is now genuinely NULL-able rather
-- than merely declared so: a doc with annotations but no authors gets a row here
-- for the first time, with a NULL byline instead of no row at all. It renders as
-- the same empty cell and still sorts `nulls: "last"`, so nothing downstream
-- moves — but the DocMetrics comment claiming "never NULL in practice" was true
-- of the old shape only, and is corrected alongside this.
--
-- annotation_count is COALESCEd to 0 and declared non-null on the Prisma side,
-- matching file_metrics: the {sort, nulls} form is rejected for a non-null
-- column, and a doc with *no* row here at all still sorts as a NULL relation,
-- which Prisma puts last either way. A doc with neither authors nor annotations
-- is still rowless and still renders as a blank byline and a blank count.
DROP VIEW doc_metrics;
CREATE VIEW doc_metrics AS
SELECT COALESCE(authors.doc_id, notes.doc_id) AS doc_id,
       authors.byline                         AS byline,
       COALESCE(notes.annotation_count, 0)    AS annotation_count
FROM (
    SELECT da.doc_id,
           string_agg(u.admin_initials, ', ' ORDER BY da.byline_order) AS byline
    FROM doc_author da
    JOIN "user" u ON u.id = da.user_id
    GROUP BY da.doc_id
) authors
FULL OUTER JOIN (
    SELECT a.doc_id,
           count(*)::int AS annotation_count
    FROM annotation a
    WHERE a.doc_id IS NOT NULL
      AND a.deleted_at IS NULL
      AND a.status <> 'DRAFT'
    GROUP BY a.doc_id
) notes ON notes.doc_id = authors.doc_id;
