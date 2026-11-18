-- AlterTable
ALTER TABLE "doc" ADD COLUMN     "wiki_name" TEXT,
ADD COLUMN     "wiki_name_key" TEXT,
ADD COLUMN     "wiki_owner_user_id" TEXT,
ADD COLUMN     "wiki_variant" TEXT NOT NULL DEFAULT '';

-- AddForeignKey
ALTER TABLE "doc" ADD CONSTRAINT "doc_wiki_owner_user_id_fkey" FOREIGN KEY ("wiki_owner_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written below this line (the add_anchored_links convention — appended
-- to the --create-only SQL before first apply; Prisma has no syntax for a
-- function, a trigger, a CHECK or a partial index here). docs/WIKI.md, "Data
-- model", "Names" and "The name is the title".

-- A name's key: Postgres 18's full Unicode case folding, then NFC, since
-- folding an NFC name doesn't always give NFC (ΐ and its capital fold to two
-- spellings of one letter). The fold is written here once: spelled out at a
-- call site, a missed COLLATE would fold by the database's default collation,
-- where casefold('Straße') is 'straße'. docs/WIKI.md "Case".
CREATE FUNCTION public.wiki_name_key(name text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog
RETURN normalize(casefold(name COLLATE pg_unicode_fast), NFC);

-- Whether every ")" closes a "(" before it and every "(" is closed: a Markdown
-- link takes balanced parentheses only, and a URL is written as it is.
CREATE FUNCTION public.wiki_name_parens_balanced(name text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog
AS $$
DECLARE
  depth integer := 0;
  ch text;
BEGIN
  FOREACH ch IN ARRAY regexp_split_to_array(name, '') LOOP
    IF ch = '(' THEN
      depth := depth + 1;
    ELSIF ch = ')' THEN
      depth := depth - 1;
      IF depth < 0 THEN
        RETURN false;
      END IF;
    END IF;
  END LOOP;
  RETURN depth = 0;
END;
$$;

-- wiki_name_key is written only here, on insert and whenever the name
-- changes: never assign to it (CLAUDE.md's trigger-written columns). A plain
-- column rather than a STORED generated one, which drifts under Migrate
-- (PLAN.md §16l), as prose_json_length is.
CREATE FUNCTION public.doc_sync_wiki_name_key() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  NEW.wiki_name_key := wiki_name_key(NEW.wiki_name);
  RETURN NEW;
END;
$$;
CREATE TRIGGER doc_sync_wiki_name_key
BEFORE INSERT OR UPDATE OF wiki_name ON "doc"
FOR EACH ROW EXECUTE FUNCTION public.doc_sync_wiki_name_key();

-- A wiki page's title is its name ("The name is the title"), whoever writes
-- `title`: the collab server's cache write, which writes the title fragment's
-- text, included. BEFORE triggers fire in name order, and this one must run
-- before doc_sync_search_vector, so that the vector is computed from the
-- name: "doc_mirror" sorts before "doc_sync". A column-specific trigger fires
-- by the columns a statement names, never by what another trigger changes, so
-- every write that sets wiki_name names title too, or the vector stays on the
-- old name.
CREATE FUNCTION public.doc_mirror_wiki_name() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  NEW.title := NEW.wiki_name;
  RETURN NEW;
END;
$$;
CREATE TRIGGER doc_mirror_wiki_name
BEFORE INSERT OR UPDATE OF title, wiki_name ON "doc"
FOR EACH ROW WHEN (NEW.wiki_name IS NOT NULL)
EXECUTE FUNCTION public.doc_mirror_wiki_name();

-- An owner or a variant only on a wiki page.
ALTER TABLE "doc" ADD CONSTRAINT "doc_wiki_owner_needs_name"
  CHECK ("wiki_owner_user_id" IS NULL OR "wiki_name" IS NOT NULL);
ALTER TABLE "doc" ADD CONSTRAINT "doc_wiki_variant_needs_name"
  CHECK ("wiki_variant" = '' OR "wiki_name" IS NOT NULL);
-- PUBLIC is a wiki page's alone, and a commons page is never PRIVATE: its
-- name would be held where the other editors can't see it.
ALTER TABLE "doc" ADD CONSTRAINT "doc_public_only_wiki"
  CHECK ("visibility" <> 'PUBLIC' OR "wiki_name" IS NOT NULL);
ALTER TABLE "doc" ADD CONSTRAINT "doc_commons_not_private"
  CHECK ("wiki_name" IS NULL OR "wiki_owner_user_id" IS NOT NULL OR "visibility" <> 'PRIVATE');
-- A name as src/lib/wiki-name.ts leaves one, so no row holds a name no URL
-- reaches: NFC, assigned code points only (casefold and NFC are frozen only
-- for those), 1 to 255 bytes, none of the refused characters or sequences
-- (C0 controls, DEL, # < > [ ] { } | / \ ? ~, U+FFFD, %xx, &…;, a final
-- .rsc), spaces already folded (no _, no other space character, no bidi
-- mark, no run, none at an end), not a dot segment, and balanced parentheses.
ALTER TABLE "doc" ADD CONSTRAINT "doc_wiki_name_valid"
  CHECK ("wiki_name" IS NULL OR (
         "wiki_name" IS NFC NORMALIZED
     AND unicode_assigned("wiki_name")
     AND octet_length("wiki_name") BETWEEN 1 AND 255
     AND "wiki_name" !~ '[\x01-\x1F\x7F#<>\[\]{}|/\\?~\uFFFD]|%[0-9A-Fa-f]{2}|&[^\x01-\x2F\x3A-\x40\x5B-\x60\x7B-\x7F]+;|\.[Rr][Ss][Cc]$'
     AND "wiki_name" !~ '[_\u00A0\u1680\u180E\u2000-\u200A\u200E\u200F\u2028-\u202F\u205F\u3000]|  |^ | $'
     AND "wiki_name" NOT IN ('.', '..')
     AND wiki_name_parens_balanced("wiki_name")));
ALTER TABLE "doc" ADD CONSTRAINT "doc_wiki_variant_is_slug"
  CHECK ("wiki_variant" = '' OR "wiki_variant" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
-- Files share the enum and never take PUBLIC, which keeps the file code's
-- visibility comparisons correct as they are.
ALTER TABLE "file" ADD CONSTRAINT "file_not_public"
  CHECK ("visibility" <> 'PUBLIC');

-- One live page per address, compared by key. A commons page's owner is
-- null, which a unique index treats as distinct, so the commons has an index
-- of its own. A deleted page gives its address back.
CREATE UNIQUE INDEX "doc_wiki_personal_live_key"
  ON "doc" ("wiki_owner_user_id", "wiki_name_key", "wiki_variant")
  WHERE "deleted_by_user_id" IS NULL AND "wiki_owner_user_id" IS NOT NULL;
CREATE UNIQUE INDEX "doc_wiki_commons_live_key"
  ON "doc" ("wiki_name_key", "wiki_variant")
  WHERE "deleted_by_user_id" IS NULL AND "wiki_name" IS NOT NULL
    AND "wiki_owner_user_id" IS NULL;
-- "Same name", across namespaces.
CREATE INDEX "doc_wiki_name_key_idx" ON "doc" ("wiki_name_key")
  WHERE "wiki_name_key" IS NOT NULL;
