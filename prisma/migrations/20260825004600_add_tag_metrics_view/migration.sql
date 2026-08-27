-- /tags' derived columns, as a view (PLAN.md §20d, §16e, §16l). Its own
-- migration rather than an append to add_tags, matching add_doc_metrics_view:
-- the tables are the feature, the view is how one admin table sorts, and the two
-- are worth being able to roll back independently.
--
-- WHY THIS GROUPS tag_assignment/tag_anchor RATHER THAN SELECTING FROM
-- tag. A view that reads its own base table gets that table scanned twice on
-- every sort through it: Prisma emits a LEFT JOIN for a to-one relation ordering
-- however the relation is declared, and Postgres 18's self-join elimination —
-- exactly the optimisation for this — only collapses INNER joins. Grouping the
-- owned tables removes the second reference to `tag` instead of hoping it is
-- optimised away, which is the lesson add_doc_metrics_view records.
--
-- The cost is one semantic difference, and it is the same harmless one
-- doc_metrics carries: a tag nobody has used has **no row here at all**,
-- where a `FROM tag` form would give it a row of zeroes. The page reads
-- `tag.metrics?.x ?? 0` and orders the relation `nulls: "last"`, so an
-- unused term renders as a row of zeroes and sorts last either way.
--
-- WHAT COUNTS AS "USED". Live assignments only (a soft-deleted assignment is an
-- undone act), and only anchors whose *target* is itself live — the same stance
-- file_metrics.annotation_count takes, and for the same reason: a count that
-- includes rows nothing can reach reads as usage that isn't there. Publication
-- state is deliberately NOT filtered: a draft post is real content an editor is
-- curating, unlike a DRAFT annotation, which is private by design. The
-- permission-filtered counts a *reader* sees come from /tag/[slug]'s own
-- per-type queries and never from here (§20d) — this view has no viewer and
-- must not be mistaken for one.
--
-- Every aggregate is cheap (count DISTINCT over an indexed FK, one max), so
-- nothing here earns the trigger-maintained-column treatment Doc.prose_json_length
-- gets. The §16l rule decides that by measurement, and until sorting by usage
-- measures badly at real scale it decides "view".
CREATE VIEW tag_metrics AS
WITH live_anchor AS (
    SELECT a.tag_id,
           a.id         AS assignment_id,
           a.created_at AS assigned_at,
           k.doc_id,
           k.post_id,
           k.file_id,
           k.target_annotation_id
    FROM tag_assignment a
    JOIN tag_anchor k ON k.assignment_id = a.id
    -- Exactly one of these four joins matches, by tag_anchor_one_target_check
    -- (§20b). So COALESCE below reads the matched target's deleted_at and NULL
    -- for the three that didn't join — which is what lets one predicate cover
    -- all four arc legs instead of four OR'd branches.
    LEFT JOIN doc        d ON d.id = k.doc_id
    LEFT JOIN post       p ON p.id = k.post_id
    LEFT JOIN "file"     f ON f.id = k.file_id
    LEFT JOIN annotation n ON n.id = k.target_annotation_id
    WHERE a.deleted_at IS NULL
      AND COALESCE(d.deleted_at, p.deleted_at, f.deleted_at, n.deleted_at) IS NULL
)
SELECT tag_id,
       -- DISTINCT because a multi-part act (PR 2) is one assignment with several
       -- anchors, and joining them multiplies the row it came from.
       count(DISTINCT assignment_id)::int        AS assignment_count,
       count(DISTINCT doc_id)::int               AS doc_count,
       count(DISTINCT post_id)::int              AS post_count,
       count(DISTINCT file_id)::int              AS file_count,
       count(DISTINCT target_annotation_id)::int AS annotation_count,
       max(assigned_at)                          AS last_used_at
FROM live_anchor
GROUP BY tag_id;
