-- AlterTable
ALTER TABLE "citation" ADD COLUMN     "comment_id" TEXT;

-- AlterTable
ALTER TABLE "mention" ADD COLUMN     "comment_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "citation_comment_id_iid_reference_id_key" ON "citation"("comment_id", "iid", "reference_id");

-- CreateIndex
CREATE UNIQUE INDEX "mention_comment_id_iid_user_id_key" ON "mention"("comment_id", "iid", "user_id");

-- AddForeignKey
ALTER TABLE "mention" ADD CONSTRAINT "mention_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "citation" ADD CONSTRAINT "citation_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Everything below is hand-written. docs/ENTITY_CHIPS.md, "Planned: chips in
-- comments", "Indexing and search": a comment is the index tables' fourth
-- kind of source, kept as the other three are (migrations `mention_index`,
-- `citation_index`), and read through `chips_in`, since a comment holds its
-- chips as nodes, as a doc does.
-- ---------------------------------------------------------------------------

ALTER TABLE "mention" DROP CONSTRAINT "mention_one_source_check";
ALTER TABLE "mention"
  ADD CONSTRAINT "mention_one_source_check"
  CHECK (num_nonnulls("doc_id", "post_id", "annotation_id", "comment_id") = 1);

ALTER TABLE "citation" DROP CONSTRAINT "citation_one_source_check";
ALTER TABLE "citation"
  ADD CONSTRAINT "citation_one_source_check"
  CHECK (num_nonnulls("doc_id", "post_id", "annotation_id", "comment_id") = 1);

-- The sync functions gain the fourth source. A function's arguments are part
-- of its identity, so each is dropped and made again, and every trigger
-- function that calls one is replaced to pass the new argument: plpgsql
-- resolves a call when it runs, so one left calling the old signature would
-- fail at its next write.
DROP FUNCTION public.mention_sync(text, text, text, jsonb);

-- mention_sync: makes one source's rows exactly `wanted`, as before. Exactly
-- one of the four ids is non-null, so the OR matches that source's rows and
-- no other's: a comparison with NULL is never true.
CREATE FUNCTION public.mention_sync(p_doc_id text, p_post_id text, p_annotation_id text, p_comment_id text, wanted jsonb) RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  DELETE FROM "mention" m
  WHERE (m.doc_id = p_doc_id OR m.post_id = p_post_id OR m.annotation_id = p_annotation_id OR m.comment_id = p_comment_id)
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_to_recordset(wanted) AS w(iid text, user_id text)
      WHERE w.iid = m.iid AND w.user_id = m.user_id
    );

  INSERT INTO "mention" (user_id, iid, doc_id, post_id, annotation_id, comment_id)
  SELECT DISTINCT w.user_id, w.iid, p_doc_id, p_post_id, p_annotation_id, p_comment_id
  FROM jsonb_to_recordset(wanted) AS w(iid text, user_id text)
  JOIN "user" u ON u.id = w.user_id
  WHERE w.iid IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM "mention" m
      WHERE (m.doc_id = p_doc_id OR m.post_id = p_post_id OR m.annotation_id = p_annotation_id OR m.comment_id = p_comment_id)
        AND m.iid = w.iid AND m.user_id = w.user_id
    );
END;
$$;

DROP FUNCTION public.citation_sync(text, text, text, jsonb);

CREATE FUNCTION public.citation_sync(p_doc_id text, p_post_id text, p_annotation_id text, p_comment_id text, wanted jsonb) RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  DELETE FROM "citation" c
  WHERE (c.doc_id = p_doc_id OR c.post_id = p_post_id OR c.annotation_id = p_annotation_id OR c.comment_id = p_comment_id)
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_to_recordset(wanted) AS w(iid text, reference_id text)
      WHERE w.iid = c.iid AND w.reference_id = c.reference_id
    );

  INSERT INTO "citation" (reference_id, iid, doc_id, post_id, annotation_id, comment_id)
  SELECT DISTINCT w.reference_id, w.iid, p_doc_id, p_post_id, p_annotation_id, p_comment_id
  FROM jsonb_to_recordset(wanted) AS w(iid text, reference_id text)
  JOIN "reference" r ON r.id = w.reference_id
  WHERE w.iid IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM "citation" c
      WHERE (c.doc_id = p_doc_id OR c.post_id = p_post_id OR c.annotation_id = p_annotation_id OR c.comment_id = p_comment_id)
        AND c.iid = w.iid AND c.reference_id = w.reference_id
    );
END;
$$;

-- The existing triggers' functions, calling the new signature.
CREATE OR REPLACE FUNCTION public.doc_sync_mentions() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  PERFORM public.mention_sync(NEW.id, NULL, NULL, NULL, public.mentions_wanted(NEW.prose_json));
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.annotation_sync_mentions() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  PERFORM public.mention_sync(
    NULL, NULL, NEW.id, NULL,
    CASE WHEN NEW.status = 'DRAFT' THEN '[]'::jsonb ELSE public.mentions_wanted(NEW.prose_json) END
  );
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.post_sync_mentions() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  PERFORM public.mention_sync(NULL, NEW.id, NULL, NULL, public.post_mentions_wanted(NEW.prose_json));
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.doc_sync_citations() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  PERFORM public.citation_sync(NEW.id, NULL, NULL, NULL, public.citations_wanted(NEW.prose_json));
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.annotation_sync_citations() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  PERFORM public.citation_sync(
    NULL, NULL, NEW.id, NULL,
    CASE WHEN NEW.status = 'DRAFT' THEN '[]'::jsonb ELSE public.citations_wanted(NEW.prose_json) END
  );
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.post_sync_citations() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  PERFORM public.citation_sync(NULL, NEW.id, NULL, NULL, public.post_citations_wanted(NEW.prose_json));
  RETURN NULL;
END;
$$;

-- A comment's rows. Only an APPROVED comment has any: a mention in a PENDING
-- or SPAM comment has reached nobody, and approval is when it is first seen,
-- as posting is for a note. A deleted comment keeps its rows, as a deleted
-- note does; every reader filters through `publicCommentsWhere`.
CREATE FUNCTION public.comment_sync_mentions() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  PERFORM public.mention_sync(
    NULL, NULL, NULL, NEW.id,
    CASE WHEN NEW.status = 'APPROVED' THEN public.mentions_wanted(NEW.body) ELSE '[]'::jsonb END
  );
  RETURN NULL;
END;
$$;

CREATE TRIGGER comment_sync_mentions
AFTER INSERT OR UPDATE OF body, status ON "comment"
FOR EACH ROW EXECUTE FUNCTION public.comment_sync_mentions();

CREATE FUNCTION public.comment_sync_citations() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  PERFORM public.citation_sync(
    NULL, NULL, NULL, NEW.id,
    CASE WHEN NEW.status = 'APPROVED' THEN public.citations_wanted(NEW.body) ELSE '[]'::jsonb END
  );
  RETURN NULL;
END;
$$;

CREATE TRIGGER comment_sync_citations
AFTER INSERT OR UPDATE OF body, status ON "comment"
FOR EACH ROW EXECUTE FUNCTION public.comment_sync_citations();

-- No backfill: no stored comment can hold a chip before this.
