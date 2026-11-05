-- CreateTable
CREATE TABLE "citation" (
    "id" BIGSERIAL NOT NULL,
    "reference_id" TEXT NOT NULL,
    "iid" TEXT NOT NULL,
    "doc_id" TEXT,
    "post_id" TEXT,
    "annotation_id" TEXT,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "citation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "citation_reference_id_idx" ON "citation"("reference_id");

-- CreateIndex
CREATE UNIQUE INDEX "citation_doc_id_iid_reference_id_key" ON "citation"("doc_id", "iid", "reference_id");

-- CreateIndex
CREATE UNIQUE INDEX "citation_post_id_iid_reference_id_key" ON "citation"("post_id", "iid", "reference_id");

-- CreateIndex
CREATE UNIQUE INDEX "citation_annotation_id_iid_reference_id_key" ON "citation"("annotation_id", "iid", "reference_id");

-- AddForeignKey
ALTER TABLE "citation" ADD CONSTRAINT "citation_reference_id_fkey" FOREIGN KEY ("reference_id") REFERENCES "reference"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "citation" ADD CONSTRAINT "citation_doc_id_fkey" FOREIGN KEY ("doc_id") REFERENCES "doc"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "citation" ADD CONSTRAINT "citation_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "citation" ADD CONSTRAINT "citation_annotation_id_fkey" FOREIGN KEY ("annotation_id") REFERENCES "annotation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Everything below is hand-written. docs/ENTITY_CHIPS.md, step 1, item 12:
-- the citation chip kind's index table, kept exactly as `mention` is
-- (migration `mention_index`), whose `chips_in` and `post_chips_in` it reuses.
-- ---------------------------------------------------------------------------

ALTER TABLE "citation"
  ADD CONSTRAINT "citation_one_source_check"
  CHECK (num_nonnulls("doc_id", "post_id", "annotation_id") = 1);

-- citation_sync: makes one source's rows exactly `wanted`, a jsonb array of
-- {"iid", "reference_id"}. A diff, so a row whose chip still cites that work
-- keeps its first_seen_at. An id that names no reference is skipped, never
-- raised: a chip can be pasted with any id, and a store must not fail on it.
CREATE FUNCTION public.citation_sync(p_doc_id text, p_post_id text, p_annotation_id text, wanted jsonb) RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  DELETE FROM "citation" c
  WHERE (c.doc_id = p_doc_id OR c.post_id = p_post_id OR c.annotation_id = p_annotation_id)
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_to_recordset(wanted) AS w(iid text, reference_id text)
      WHERE w.iid = c.iid AND w.reference_id = c.reference_id
    );

  INSERT INTO "citation" (reference_id, iid, doc_id, post_id, annotation_id)
  SELECT DISTINCT w.reference_id, w.iid, p_doc_id, p_post_id, p_annotation_id
  FROM jsonb_to_recordset(wanted) AS w(iid text, reference_id text)
  JOIN "reference" r ON r.id = w.reference_id
  WHERE w.iid IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM "citation" c
      WHERE (c.doc_id = p_doc_id OR c.post_id = p_post_id OR c.annotation_id = p_annotation_id)
        AND c.iid = w.iid AND c.reference_id = w.reference_id
    );
END;
$$;

-- What each kind of source wants: one {"iid", "reference_id"} per work each
-- citation chip names. A citation's works are its `data.items[].refId`.
CREATE FUNCTION public.citations_wanted(doc jsonb) RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT coalesce(jsonb_agg(DISTINCT jsonb_build_object('iid', c.iid, 'reference_id', item.item ->> 'refId')), '[]'::jsonb)
  FROM public.chips_in(doc) AS c
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(c.data -> 'items') = 'array' THEN c.data -> 'items' ELSE '[]'::jsonb END
  ) AS item(item)
  WHERE c.kind = 'citation' AND c.iid IS NOT NULL AND jsonb_typeof(item.item -> 'refId') = 'string';
$$;

CREATE FUNCTION public.post_citations_wanted(doc jsonb) RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT coalesce(jsonb_agg(DISTINCT jsonb_build_object('iid', c.iid, 'reference_id', target.id)), '[]'::jsonb)
  FROM public.post_chips_in(doc) AS c
  CROSS JOIN LATERAL jsonb_array_elements_text(
    CASE WHEN jsonb_typeof(c.targets) = 'array' THEN c.targets ELSE '[]'::jsonb END
  ) AS target(id)
  WHERE c.kind = 'citation' AND c.iid IS NOT NULL;
$$;

CREATE FUNCTION public.doc_sync_citations() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  PERFORM public.citation_sync(NEW.id, NULL, NULL, public.citations_wanted(NEW.prose_json));
  RETURN NULL;
END;
$$;

CREATE TRIGGER doc_sync_citations
AFTER INSERT OR UPDATE OF prose_json ON "doc"
FOR EACH ROW EXECUTE FUNCTION public.doc_sync_citations();

-- A DRAFT is a private note: its rows appear when it is posted.
CREATE FUNCTION public.annotation_sync_citations() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  PERFORM public.citation_sync(
    NULL, NULL, NEW.id,
    CASE WHEN NEW.status = 'DRAFT' THEN '[]'::jsonb ELSE public.citations_wanted(NEW.prose_json) END
  );
  RETURN NULL;
END;
$$;

CREATE TRIGGER annotation_sync_citations
AFTER INSERT OR UPDATE OF prose_json, status ON "annotation"
FOR EACH ROW EXECUTE FUNCTION public.annotation_sync_citations();

CREATE FUNCTION public.post_sync_citations() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  PERFORM public.citation_sync(NULL, NEW.id, NULL, public.post_citations_wanted(NEW.prose_json));
  RETURN NULL;
END;
$$;

CREATE TRIGGER post_sync_citations
AFTER INSERT OR UPDATE OF prose_json ON "post"
FOR EACH ROW EXECUTE FUNCTION public.post_sync_citations();

-- No backfill: no stored document can hold a citation chip before this.
