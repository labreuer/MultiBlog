-- The two /posts columns that had no sort: Author(s) and Comments (PLAN.md
-- §16e's table, §16l's "remaining four"). Same move post_activity made — a
-- view keyed 1:1 on the base table's primary key is a *to-one* relation, and
-- Prisma orders a to-one relation's columns freely, so an expression it could
-- never name becomes an ordinary `orderBy`.
--
-- Separate from post_activity rather than folded into it, and the reason is
-- not tidiness: post_activity is an argmax (DISTINCT ON over
-- post_publication_event, one row only for posts that have events, served
-- straight from that table's (post_id, created_at) index and never touching
-- post at all). This is an aggregate over post, one row for every post
-- always. Merging them would force one plan shape onto both and would change
-- post_activity's row-presence semantics, which its nulls-last ordering
-- depends on.
--
-- byline stays NULL for a post with no authors rather than COALESCEing to '':
-- '' sorts first ascending, so an authorless post would lead the table, while
-- NULL with `nulls: "last"` keeps it out of the way in both directions —
-- matching how post_activity already treats "no data". The application
-- renders it as the same empty string either way.
--
-- string_agg with ORDER BY byline_order reproduces the byline exactly as the
-- table already prints it (the old `authors` include ordered by bylineOrder
-- and joined with ", " in JS), so the sorted expression and the displayed one
-- are the same expression — the property §16e made the deciding factor for
-- post_activity. It is served by post_author's primary key, (post_id,
-- user_id), whose leading column is what the correlation needs.
--
-- The comment counts repeat, in SQL, the filter the page did in JS: a
-- soft-deleted comment counts for nothing, and only APPROVED and PENDING are
-- shown (SPAM and DELETED are deliberately absent from both). count(*) FILTER
-- rather than two correlated subqueries so one pass over the post's comments
-- produces both. Cast to int because count() is bigint, which Prisma would
-- otherwise surface as a BigInt the table has no use for.
--
-- LEFT JOIN LATERAL ... ON TRUE for both: the aggregate subqueries return
-- exactly one row each even for a post with no authors and no comments, so
-- every post gets a row and the relation is total. (It is still declared
-- optional on the Prisma side — see PostMetrics in schema.prisma, and the
-- note below for why declaring it required would not have helped anyway.)
--
-- One cost this shape carries, worth stating rather than re-deriving: the
-- view reads FROM post, and Prisma joins it *back* to post to sort, so post is
-- scanned twice. Postgres 18 added self-join elimination, which is precisely
-- the optimisation that would collapse those two scans — and it does not fire
-- here. It only applies to INNER joins, and
-- Prisma emits a LEFT JOIN for a to-one relation ordering no matter how the
-- relation is declared. All three of those claims were checked against this
-- database and this client rather than assumed:
--   - EXPLAIN on the inner-join form of this shape collapses to a single Seq
--     Scan; the left-join form keeps both scans (enable_self_join_elimination
--     is on by default).
--   - Prisma logs `LEFT JOIN "public"."post_metrics" AS "orderby_1"` for the
--     orderBy, and a plain `WHERE post_id IN (…)` second query for the
--     `include` — the display path is not a join at all.
--   - Prisma rejects a 1:1 with both sides required, and flipping *which*
--     side is optional produces byte-identical SQL, still LEFT JOIN.
-- So the second scan is simply the price of sorting through a view that reads
-- its own base table. It is cheap at admin-table scale and there is nothing to
-- tune. doc_metrics avoids it by grouping doc_author instead of selecting FROM
-- doc — the same trick would work here (a FULL OUTER JOIN of the two
-- aggregates, keyed on post_id), at the cost of this view's readability and of
-- making both counts nullable for a post that has authors but no comments.
-- Not worth it for one avoided scan of a small table; noted so the asymmetry
-- between the two views reads as a decision rather than an oversight.
CREATE VIEW post_metrics AS
SELECT p.id AS post_id,
       a.byline,
       c.approved_count,
       c.pending_count
FROM post p
LEFT JOIN LATERAL (
  SELECT string_agg(u.admin_initials, ', ' ORDER BY pa.byline_order) AS byline
  FROM post_author pa
  JOIN "user" u ON u.id = pa.user_id
  WHERE pa.post_id = p.id
) a ON TRUE
LEFT JOIN LATERAL (
  SELECT (count(*) FILTER (WHERE cm.status = 'APPROVED'))::int AS approved_count,
         (count(*) FILTER (WHERE cm.status = 'PENDING'))::int  AS pending_count
  FROM comment_thread t
  JOIN comment cm ON cm.thread_id = t.id
  WHERE t.post_id = p.id
    AND cm.deleted_by_user_id IS NULL
) c ON TRUE;
