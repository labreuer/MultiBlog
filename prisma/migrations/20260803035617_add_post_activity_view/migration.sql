-- The latest publication event per post, and who made it — the two values
-- /posts shows as "Last edit by" / "Last edit at" (PLAN.md §16e).
--
-- DISTINCT ON is an argmax: per post_id, keep the row with the greatest
-- created_at. Prisma's orderBy can't express that over a to-many relation
-- (PostPublicationEventOrderByRelationAggregateInput has only _count), but it
-- orders a *to-one* relation's columns freely — and a view keyed 1:1 on
-- post_id is exactly a to-one relation. Serves the ORDER BY straight from
-- post_publication_event's existing (post_id, created_at) index.
--
-- A post with no events has no row here, which is why PostActivity is a
-- nullable relation and both columns sort nulls-last: that matches what the
-- table already displayed for such a post ("—" and an empty cell).
--
-- The `e.id DESC` tiebreaker is what makes "latest" deterministic. created_at
-- alone is not a unique ordering key, so which row won a tie would otherwise
-- be arbitrary — DISTINCT ON picks one of the tied rows without saying which,
-- and ROW_NUMBER() = 1 would be no better. Not reachable today (each of the
-- three postPublicationEvent.create sites in src/app/actions/posts.ts writes
-- exactly one event per transaction, and now() is the transaction timestamp,
-- so two events can't share one), but the guarantee costs nothing and stops
-- the view from depending on that staying true. id rather than a second
-- timestamp because it is the primary key, so it is unique by definition,
-- which is the whole point.
--
-- On changing this later: Postgres permits CREATE OR REPLACE VIEW only when
-- the new query yields the same column names and types in the same order (new
-- columns may be appended). Anything that removes or retypes a column needs
-- DROP + CREATE instead.
CREATE VIEW post_activity AS
SELECT DISTINCT ON (e.post_id)
       e.post_id,
       e.created_at              AS last_event_at,
       COALESCE(u.name, u.email) AS last_editor_name
FROM post_publication_event e
LEFT JOIN "user" u ON u.id = e.actor_id
ORDER BY e.post_id, e.created_at DESC, e.id DESC;
