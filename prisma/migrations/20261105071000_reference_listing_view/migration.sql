-- docs/CITATIONS.md, "Pages" — what /references sorts by that lives inside
-- `reference.csl`. A view keyed 1:1 on the reference, the admin tables' way
-- of sorting by something a plain ORDER BY can't name (PLAN.md §16e), rather
-- than three more columns for the trigger to keep.
--
-- `people` is the authors, then the editors, each as "Family Given": the
-- order a library is alphabetized in. `year` is read only when it is a year,
-- so a malformed date in a record sorts as undated rather than failing the
-- whole page.
CREATE VIEW reference_listing AS
SELECT
  r.id AS reference_id,
  r.csl ->> 'title' AS title,
  (
    SELECT string_agg(concat_ws(' ', person ->> 'family', person ->> 'literal', person ->> 'given'), '; ' ORDER BY ord)
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(r.csl -> 'author') = 'array' THEN r.csl -> 'author' ELSE '[]'::jsonb END
      || CASE WHEN jsonb_typeof(r.csl -> 'editor') = 'array' THEN r.csl -> 'editor' ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS people(person, ord)
  ) AS people,
  CASE WHEN r.csl #>> '{issued,date-parts,0,0}' ~ '^[0-9]{1,4}$' THEN (r.csl #>> '{issued,date-parts,0,0}')::integer END AS year
FROM "reference" r;
