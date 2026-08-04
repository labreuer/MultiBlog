-- /docs' Author(s) column, which had no sort (PLAN.md §16e, §16l). Same shape
-- as post_metrics — a view keyed 1:1 on doc.id, so Prisma sees a to-one
-- relation and can order by its columns rather than being stuck with the
-- `_count` that a to-many offers.
--
-- byline is the same string_agg over the byline order that post_metrics does,
-- for the same reason (the sorted expression *is* the displayed one), served
-- by doc_author's (doc_id, user_id) primary key.
--
-- WHY THIS GROUPS doc_author RATHER THAN SELECTING FROM doc. post_metrics
-- reads FROM post and correlates, which is the more readable shape and gives
-- every row a view row. It also means Prisma's LEFT JOIN back to the base
-- table scans that table twice on every sort through the view — Postgres 18's
-- self-join elimination is exactly the optimisation for that and cannot fire,
-- because it only applies to INNER joins and Prisma emits a LEFT JOIN for a
-- to-one relation ordering however the relation is declared. Grouping the
-- join table removes the second reference to doc instead of optimising it, so
-- this view never touches doc at all.
--
-- That was worth doing here and not in post_metrics because /docs' other
-- derived column, Length, would have forced this view to read doc anyway
-- (doc_length is a function of doc.prose_json). It doesn't: Length is a
-- stored column maintained by a trigger — see add_doc_prose_json_length for
-- the measurements that decided it — which leaves nothing here that needs the
-- base table.
--
-- The cost is one semantic difference, and it is harmless: a doc with *no*
-- authors has no row here at all, where a FROM doc form would give it a row
-- with a NULL byline. Both render as the same empty cell (the page reads
-- `doc.metrics?.byline ?? ""`) and both sort the same way, since the relation
-- is optional and already ordered `nulls: "last"`.
CREATE VIEW doc_metrics AS
SELECT da.doc_id,
       string_agg(u.admin_initials, ', ' ORDER BY da.byline_order) AS byline
FROM doc_author da
JOIN "user" u ON u.id = da.user_id
GROUP BY da.doc_id;
