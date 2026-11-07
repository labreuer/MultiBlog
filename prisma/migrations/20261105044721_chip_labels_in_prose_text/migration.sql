-- prose_text(jsonb) reads an entity chip's label.
--
-- An entity chip (docs/ENTITY_CHIPS.md) is an inline leaf that holds which
-- person or work it stands for and no text. A doc's prose_json carries each
-- chip's computed label as `attrs.label`, written with the rest of the cache,
-- so that this function has something to read: without it a doc that says
-- "ask @Ada Lovelace" is indexed, and excerpted in search results, as "ask ".
--
-- The one change is the chip's piece. A chip with no label, which is one
-- written before its cache write carried labels or one in a post-side
-- document that never holds chips, contributes nothing, as before.
--
-- Nothing is re-indexed here. search_vector is trigger-maintained, so a row
-- keeps its vector until its title or prose_json is next written, but no row
-- can differ: the chip node and its label reach a database in the same
-- deploy as this function, and a doc gets its first chip through a store,
-- which writes prose_json and fires the trigger.
--
-- CREATE OR REPLACE keeps the function's identity, so doc_search_vector and
-- post_search_vector, which call it by name, need nothing.
CREATE OR REPLACE FUNCTION public.prose_text(doc jsonb) RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  WITH RECURSIVE nodes(node, path) AS (
    SELECT doc, ARRAY[]::integer[]
    UNION ALL
    SELECT child.node, nodes.path || child.ord::integer
    FROM nodes
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(nodes.node -> 'content') = 'array' THEN nodes.node -> 'content' ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS child(node, ord)
  ),
  pieces AS (
    SELECT path[1:cardinality(path) - 1] AS block,
           path,
           CASE node ->> 'type'
             WHEN 'text' THEN node ->> 'text'
             WHEN 'entityChip' THEN node #>> '{attrs,label}'
             ELSE E'\n'
           END AS piece
    FROM nodes
    WHERE (node ->> 'type' = 'text' AND jsonb_typeof(node -> 'text') = 'string')
       OR (node ->> 'type' = 'entityChip' AND jsonb_typeof(node #> '{attrs,label}') = 'string')
       OR node ->> 'type' = 'hardBreak'
  ),
  blocks AS (
    SELECT block, string_agg(piece, '' ORDER BY path) AS text
    FROM pieces
    GROUP BY block
  )
  SELECT coalesce(string_agg(text, E'\n' ORDER BY block), '') FROM blocks;
$$;
