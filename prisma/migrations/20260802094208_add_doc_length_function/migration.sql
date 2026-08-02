-- Hand-written: Prisma's schema DSL has no notion of a standalone SQL
-- function, so there is nothing in schema.prisma to diff this from (same
-- reason doc_link's CHECK constraint migration was hand-written).
--
-- Computes the plain-text character length of a TipTap/ProseMirror document
-- stored as JSONB (doc.prose_json), without pulling the document itself into
-- the app to measure it — the /docs table's "Length" column selects this
-- function's result instead of prose_json.
--
-- Sums the length of every {"type":"text","text":"..."} leaf's "text" field —
-- the same notion of "text" extractText (src/lib/diff.ts) sums the length of,
-- minus extractText's "\n\n" block-separator padding, which a length column
-- has no reason to count.
--
-- A RECURSIVE CTE over jsonb_array_elements/jsonb_each, not a jsonpath `**`
-- expression: `jsonb_path_query(doc, '$.**.text')` looks like the obvious way
-- to write this and was tried first, but DOUBLE-COUNTS every match — verified
-- against Postgres 14 directly, e.g. a single {"type":"text","text":"hello"}
-- leaf yields ["hello","hello"], consistently 2x regardless of nesting depth,
-- whenever the matched object sits inside a JSON *array* (exactly the shape
-- every TipTap node uses for `content`, so it is not an edge case — it is
-- every real document). Filed as a real, reproduced bug in the first version
-- of this migration rather than assumed; the recursive-CTE form below has no
-- such quirk and was cross-checked to match a plain JS walk across every doc
-- in a real corpus (import-etherpad.ts's, 50 docs) exactly.
--
-- The walk visits: the doc itself; every element of a node that's an array;
-- every value of a node that's an object (which is how it reaches into a
-- node's own "content" array and, harmlessly, into "attrs"/"marks" — nothing
-- in this schema's marks or node attrs has a field named "text", so descending
-- through them costs nothing and finds nothing). Only stops to sum at a node
-- that is itself an object with "type": "text" and a string "text" field —
-- mirroring extractText's own `node.type === "text"` check exactly, so a
-- future node/mark that happens to carry an unrelated "text"-named attribute
-- still can't be mistaken for a text run.
--
-- IMMUTABLE + PARALLEL SAFE: a pure function of its argument, touches no
-- table, so Postgres is free to inline/parallelize it — matters here since it
-- runs once per row in a WHERE id = ANY(...) scan.
CREATE OR REPLACE FUNCTION doc_length(doc jsonb)
RETURNS integer
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  WITH RECURSIVE nodes(node) AS (
    SELECT COALESCE(doc, 'null'::jsonb)
    UNION ALL
    SELECT elem
    FROM nodes
    CROSS JOIN LATERAL (
      SELECT value AS elem FROM jsonb_array_elements(nodes.node) WHERE jsonb_typeof(nodes.node) = 'array'
      UNION ALL
      SELECT value AS elem FROM jsonb_each(nodes.node) WHERE jsonb_typeof(nodes.node) = 'object'
    ) AS expansion
  )
  SELECT COALESCE(SUM(length(node ->> 'text')), 0)::integer
  FROM nodes
  WHERE jsonb_typeof(node) = 'object' AND node ->> 'type' = 'text' AND jsonb_typeof(node -> 'text') = 'string';
$$;
