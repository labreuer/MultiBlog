-- /docs and /files gain a Tags column (PLAN.md §20n), and these two views are
-- what it reads and sorts through: one row per tagged object, keyed 1:1 on its
-- id so Prisma sees a to-one relation (§16e). `names` is the sort key and
-- `terms` what the cell draws, both out of the one `applied` subquery, so the
-- displayed list and the sorted string are the same terms in the same order by
-- construction.
--
-- WHY NOT A THIRD BRANCH OF doc_metrics / file_metrics. Those views are a FULL
-- OUTER JOIN of aggregates keyed on a COALESCE. Postgres cannot prune a branch
-- of one (a branch can add rows) and cannot push the page's `doc_id IN (…)`
-- through the COALESCE, so every read of them builds the whole view, whichever
-- columns it asks for — the dashboard's byline-only read included. A tags
-- branch there would have put three tag-table scans on every such load. Here a
-- plain GROUP BY on the object's id takes `IN (…)` down into tag_anchor
-- (tag_anchor_doc_id_idx / tag_anchor_file_id_idx), and a page that isn't
-- showing Tags doesn't read the view at all. Sorting by Tags still builds the
-- whole of it, as any sort through a view does (§16l) — only on that sort.
--
-- WHAT COUNTS AS A TAG HERE. Exactly what the object page's chips show
-- (src/lib/tag-data.ts, tagsForTarget): every anchor on the object, through a
-- live assignment, to a live term. The object's own deleted_at is deliberately
-- not consulted — neither view reads doc or file, the add_doc_metrics_view
-- rule — so a soft-deleted doc listed under "Show deleted" keeps its chips, as
-- it keeps its byline. Part anchors, when they exist, count as the term being
-- on the object, as they do for the chips.
--
-- ONE ROW PER (object, term) BEFORE AGGREGATING. Several people may apply the
-- same term to the same object; the chip appears once and carries how many did
-- (TagChipList's hover title). `tagger_count` counts distinct people rather
-- than anchors, so a multi-part act by one person stays one.
--
-- ORDER. By name, then slug for two terms that share a name, in the database's
-- collation. The object page's chips sort with JS localeCompare instead; both
-- are linguistic orders and agree on anything a real vocabulary contains.
-- `names` joins them with ', ' — a sort key, never split back apart, so a
-- comma inside a name costs nothing.
CREATE VIEW doc_tag_summary AS
SELECT applied.doc_id,
       string_agg(applied.name, ', ' ORDER BY applied.name, applied.slug) AS names,
       jsonb_agg(
           jsonb_build_object('slug', applied.slug, 'name', applied.name, 'taggerCount', applied.tagger_count)
           ORDER BY applied.name, applied.slug
       ) AS terms
FROM (
    SELECT k.doc_id,
           t.slug,
           t.name,
           count(DISTINCT a.user_id)::int AS tagger_count
    FROM tag_anchor k
    JOIN tag_assignment a ON a.id = k.assignment_id
    JOIN tag t ON t.id = a.tag_id
    WHERE k.doc_id IS NOT NULL
      AND a.deleted_at IS NULL
      AND t.deleted_at IS NULL
    GROUP BY k.doc_id, t.slug, t.name
) applied
GROUP BY applied.doc_id;

-- The identical view over file_id, so the two tables answer "what is this
-- tagged with" the same way.
CREATE VIEW file_tag_summary AS
SELECT applied.file_id,
       string_agg(applied.name, ', ' ORDER BY applied.name, applied.slug) AS names,
       jsonb_agg(
           jsonb_build_object('slug', applied.slug, 'name', applied.name, 'taggerCount', applied.tagger_count)
           ORDER BY applied.name, applied.slug
       ) AS terms
FROM (
    SELECT k.file_id,
           t.slug,
           t.name,
           count(DISTINCT a.user_id)::int AS tagger_count
    FROM tag_anchor k
    JOIN tag_assignment a ON a.id = k.assignment_id
    JOIN tag t ON t.id = a.tag_id
    WHERE k.file_id IS NOT NULL
      AND a.deleted_at IS NULL
      AND t.deleted_at IS NULL
    GROUP BY k.file_id, t.slug, t.name
) applied
GROUP BY applied.file_id;
