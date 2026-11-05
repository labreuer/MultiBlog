-- CreateTable
CREATE TABLE "mention" (
    "id" BIGSERIAL NOT NULL,
    "user_id" TEXT NOT NULL,
    "iid" TEXT NOT NULL,
    "doc_id" TEXT,
    "post_id" TEXT,
    "annotation_id" TEXT,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mention_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mention_user_id_idx" ON "mention"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "mention_doc_id_iid_user_id_key" ON "mention"("doc_id", "iid", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "mention_post_id_iid_user_id_key" ON "mention"("post_id", "iid", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "mention_annotation_id_iid_user_id_key" ON "mention"("annotation_id", "iid", "user_id");

-- AddForeignKey
ALTER TABLE "mention" ADD CONSTRAINT "mention_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mention" ADD CONSTRAINT "mention_doc_id_fkey" FOREIGN KEY ("doc_id") REFERENCES "doc"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mention" ADD CONSTRAINT "mention_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mention" ADD CONSTRAINT "mention_annotation_id_fkey" FOREIGN KEY ("annotation_id") REFERENCES "annotation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Everything below is hand-written: Prisma has no syntax for a CHECK, a
-- function or a trigger. docs/ENTITY_CHIPS.md, step 1, item 12.
-- ---------------------------------------------------------------------------

-- Exactly one source, as the anchor tables' object arc is checked.
ALTER TABLE "mention"
  ADD CONSTRAINT "mention_one_source_check"
  CHECK (num_nonnulls("doc_id", "post_id", "annotation_id") = 1);


-- chips_in(jsonb): every entity chip node in a ProseMirror document, of any
-- chip kind. A doc's and an annotation's prose_json hold chips as nodes.
-- The walk is prose_text's: down `content` arrays only. NULL gives no rows.
CREATE FUNCTION public.chips_in(doc jsonb) RETURNS TABLE(kind text, iid text, data jsonb)
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  WITH RECURSIVE nodes(node) AS (
    SELECT doc
    UNION ALL
    SELECT child.node
    FROM nodes
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(nodes.node -> 'content') = 'array' THEN nodes.node -> 'content' ELSE '[]'::jsonb END
    ) AS child(node)
  )
  SELECT node #>> '{attrs,kind}', node #>> '{attrs,iid}', node #> '{attrs,data}'
  FROM nodes
  WHERE node ->> 'type' = 'entityChip';
$$;

-- post_chips_in(jsonb): the chips a published post's links stand for. A post
-- never holds a chip node; publishing turns each into linked text and records
-- the chip on the link mark's `chip` attribute, as {kind, iid, targets}. One
-- chip's text can be split over several text nodes, hence DISTINCT.
CREATE FUNCTION public.post_chips_in(doc jsonb) RETURNS TABLE(kind text, iid text, targets jsonb)
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  WITH RECURSIVE nodes(node) AS (
    SELECT doc
    UNION ALL
    SELECT child.node
    FROM nodes
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(nodes.node -> 'content') = 'array' THEN nodes.node -> 'content' ELSE '[]'::jsonb END
    ) AS child(node)
  )
  SELECT DISTINCT mark.mark #>> '{attrs,chip,kind}', mark.mark #>> '{attrs,chip,iid}', mark.mark #> '{attrs,chip,targets}'
  FROM nodes
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(nodes.node -> 'marks') = 'array' THEN nodes.node -> 'marks' ELSE '[]'::jsonb END
  ) AS mark(mark)
  WHERE mark.mark ->> 'type' = 'link'
    AND jsonb_typeof(mark.mark #> '{attrs,chip}') = 'object';
$$;


-- mention_sync: makes one source's rows exactly `wanted`, a jsonb array of
-- {"iid", "user_id"}. A diff, not a replace: a row whose chip is still there
-- is untouched and keeps its first_seen_at. A user id that names no account
-- is skipped, never raised: a chip can be pasted or typed with any id, and a
-- store must not fail on it.
--
-- Exactly one of the three ids is non-null, so the OR below matches that
-- source's rows and no other's: a comparison with NULL is never true.
CREATE FUNCTION public.mention_sync(p_doc_id text, p_post_id text, p_annotation_id text, wanted jsonb) RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  DELETE FROM "mention" m
  WHERE (m.doc_id = p_doc_id OR m.post_id = p_post_id OR m.annotation_id = p_annotation_id)
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_to_recordset(wanted) AS w(iid text, user_id text)
      WHERE w.iid = m.iid AND w.user_id = m.user_id
    );

  INSERT INTO "mention" (user_id, iid, doc_id, post_id, annotation_id)
  SELECT DISTINCT w.user_id, w.iid, p_doc_id, p_post_id, p_annotation_id
  FROM jsonb_to_recordset(wanted) AS w(iid text, user_id text)
  JOIN "user" u ON u.id = w.user_id
  WHERE w.iid IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM "mention" m
      WHERE (m.doc_id = p_doc_id OR m.post_id = p_post_id OR m.annotation_id = p_annotation_id)
        AND m.iid = w.iid AND m.user_id = w.user_id
    );
END;
$$;

-- What each kind of source wants: its mention chips as {"iid", "user_id"}.
-- Named functions, so the triggers and scripts/integrity/check-mentions.ts
-- cannot disagree about what the rows should be.
CREATE FUNCTION public.mentions_wanted(doc jsonb) RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT coalesce(jsonb_agg(DISTINCT jsonb_build_object('iid', c.iid, 'user_id', c.data ->> 'userId')), '[]'::jsonb)
  FROM public.chips_in(doc) AS c
  WHERE c.kind = 'mention' AND c.iid IS NOT NULL AND jsonb_typeof(c.data -> 'userId') = 'string';
$$;

CREATE FUNCTION public.post_mentions_wanted(doc jsonb) RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT coalesce(jsonb_agg(DISTINCT jsonb_build_object('iid', c.iid, 'user_id', target.id)), '[]'::jsonb)
  FROM public.post_chips_in(doc) AS c
  CROSS JOIN LATERAL jsonb_array_elements_text(
    CASE WHEN jsonb_typeof(c.targets) = 'array' THEN c.targets ELSE '[]'::jsonb END
  ) AS target(id)
  WHERE c.kind = 'mention' AND c.iid IS NOT NULL;
$$;


-- The triggers. AFTER, because the rows reference the source row. Each
-- function sets its own search_path, as a data-only load runs with an empty
-- one (docs/DATABASE.md).

CREATE FUNCTION public.doc_sync_mentions() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  PERFORM public.mention_sync(NEW.id, NULL, NULL, public.mentions_wanted(NEW.prose_json));
  RETURN NULL;
END;
$$;

CREATE TRIGGER doc_sync_mentions
AFTER INSERT OR UPDATE OF prose_json ON "doc"
FOR EACH ROW EXECUTE FUNCTION public.doc_sync_mentions();

-- A DRAFT is a private note, and a mention in one has reached nobody: its
-- rows appear when it is posted, which is when first_seen_at should start.
CREATE FUNCTION public.annotation_sync_mentions() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  PERFORM public.mention_sync(
    NULL, NULL, NEW.id,
    CASE WHEN NEW.status = 'DRAFT' THEN '[]'::jsonb ELSE public.mentions_wanted(NEW.prose_json) END
  );
  RETURN NULL;
END;
$$;

CREATE TRIGGER annotation_sync_mentions
AFTER INSERT OR UPDATE OF prose_json, status ON "annotation"
FOR EACH ROW EXECUTE FUNCTION public.annotation_sync_mentions();

CREATE FUNCTION public.post_sync_mentions() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  PERFORM public.mention_sync(NULL, NEW.id, NULL, public.post_mentions_wanted(NEW.prose_json));
  RETURN NULL;
END;
$$;

CREATE TRIGGER post_sync_mentions
AFTER INSERT OR UPDATE OF prose_json ON "post"
FOR EACH ROW EXECUTE FUNCTION public.post_sync_mentions();

-- No backfill: the chip node reaches a database in the same deploy as this
-- table, so no stored document holds one yet. A development database that
-- does gets its rows from `npx tsx scripts/integrity/check-mentions.ts --repair`.
