-- docs/ENTITY_CHIPS.md, step 1, item 11 — an annotation's chip record, and
-- the search vector reading it.
--
-- An anchored quote holds U+FFFC where an entity chip is, so that a rename
-- can't detach it. `anchor_chips` says which chips those are: a JSON array,
-- one entry per chip in order, each with where its U+FFFC is (`at`), its chip
-- kind, instance id and fields, and its label as of the write
-- (src/lib/anchors/chips.ts). The tag, link and comment-quote anchor tables
-- keep the same list inside their `selector`, which is already jsonb and
-- needs no column.
ALTER TABLE "annotation" ADD COLUMN "anchor_chips" JSONB;

-- A stored quote as text a reader would search for: each chip's label where
-- its U+FFFC is. The nth U+FFFC is the nth record, which is how the list is
-- written. A list that doesn't count the same as the quote's U+FFFCs
-- describes some other text, and the quote is returned as it is.
CREATE FUNCTION public.anchor_quote_text(quoted_text text, chips jsonb) RETURNS text
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  parts text[];
  labels text[];
  result text;
BEGIN
  IF quoted_text IS NULL OR chips IS NULL OR jsonb_typeof(chips) <> 'array' THEN
    RETURN coalesce(quoted_text, '');
  END IF;
  parts := string_to_array(quoted_text, chr(65532));
  SELECT array_agg(coalesce(entry.chip ->> 'label', '') ORDER BY entry.ord)
    INTO labels
    FROM jsonb_array_elements(chips) WITH ORDINALITY AS entry(chip, ord);
  IF labels IS NULL OR cardinality(parts) <> cardinality(labels) + 1 THEN
    RETURN quoted_text;
  END IF;
  result := parts[1];
  FOR i IN 1..cardinality(labels) LOOP
    result := result || labels[i] || parts[i + 1];
  END LOOP;
  RETURN result;
END;
$$;

-- The annotation vector's quoted passage, with labels. The function keeps its
-- signature; the trigger hands it the labelled quote, and now also fires
-- when the record alone changes, which is what a rename's refresh writes.
CREATE OR REPLACE FUNCTION public.annotation_sync_search_vector() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  NEW.search_vector := annotation_search_vector(NEW.body_text, anchor_quote_text(NEW.quoted_text, NEW.anchor_chips));
  RETURN NEW;
END;
$$;

DROP TRIGGER annotation_sync_search_vector ON "annotation";
CREATE TRIGGER annotation_sync_search_vector
BEFORE INSERT OR UPDATE OF body_text, quoted_text, anchor_chips ON "annotation"
FOR EACH ROW EXECUTE FUNCTION public.annotation_sync_search_vector();

-- Nothing is re-indexed: no row has a record yet, and for a null record the
-- labelled quote is the quote.
