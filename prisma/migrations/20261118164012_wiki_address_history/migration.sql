-- CreateTable
CREATE TABLE "wiki_address_history" (
    "id" TEXT NOT NULL,
    "doc_id" TEXT NOT NULL,
    "owner_user_id" TEXT,
    "name" TEXT NOT NULL,
    "name_key" TEXT,
    "variant" TEXT NOT NULL DEFAULT '',
    "reserved" BOOLEAN NOT NULL,
    "moved_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wiki_address_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "wiki_address_history_address_idx" ON "wiki_address_history"("name_key", "variant", "owner_user_id");

-- CreateIndex
CREATE INDEX "wiki_address_history_doc_idx" ON "wiki_address_history"("doc_id");

-- AddForeignKey
ALTER TABLE "wiki_address_history" ADD CONSTRAINT "wiki_address_history_doc_id_fkey" FOREIGN KEY ("doc_id") REFERENCES "doc"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wiki_address_history" ADD CONSTRAINT "wiki_address_history_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wiki_address_history" ADD CONSTRAINT "wiki_address_history_moved_by_user_id_fkey" FOREIGN KEY ("moved_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Hand-written below this line (the add_anchored_links convention — appended
-- to the --create-only SQL before first apply; Prisma has no syntax for a
-- trigger, a CHECK or a partial index here). docs/WIKI.md "Renaming".

-- name_key is written only here, on insert and whenever the name changes,
-- by the one function that folds (wiki_name_key, migration wiki_pages): never
-- assign to it (CLAUDE.md's trigger-written columns).
CREATE FUNCTION public.wiki_address_history_sync_name_key() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  NEW.name_key := wiki_name_key(NEW.name);
  RETURN NEW;
END;
$$;
CREATE TRIGGER wiki_address_history_sync_name_key
BEFORE INSERT OR UPDATE OF name ON "wiki_address_history"
FOR EACH ROW EXECUTE FUNCTION public.wiki_address_history_sync_name_key();

-- A history row's name is held to a page's rules, so no row names an address
-- no URL reaches: the same expression as doc_wiki_name_valid (migration
-- wiki_pages), and a change to one is a change to both.
ALTER TABLE "wiki_address_history" ADD CONSTRAINT "wiki_address_history_name_valid"
  CHECK (
         "name" IS NFC NORMALIZED
     AND unicode_assigned("name")
     AND octet_length("name") BETWEEN 1 AND 255
     AND "name" !~ '[\x01-\x1F\x7F#<>\[\]{}|/\\?~\uFFFD]|%[0-9A-Fa-f]{2}|&[^\x01-\x2F\x3A-\x40\x5B-\x60\x7B-\x7F]+;|\.[Rr][Ss][Cc]$'
     AND "name" !~ '[_\u00A0\u1680\u180E\u2000-\u200A\u200E\u200F\u2028-\u202F\u205F\u3000]|  |^ | $'
     AND "name" NOT IN ('.', '..')
     AND wiki_name_parens_balanced("name"));
ALTER TABLE "wiki_address_history" ADD CONSTRAINT "wiki_address_history_variant_is_slug"
  CHECK ("variant" = '' OR "variant" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

-- A reserved row holds its address, as a live page does, so reserved rows are
-- unique by owner, key and variant; the commons' null owner gets an index of
-- its own, as on doc. No index spans this table and doc: the address lock
-- (wiki-claim.ts) is what keeps an address from being both live and reserved.
-- A released row holds nothing, and an address can have many.
CREATE UNIQUE INDEX "wiki_address_history_personal_reserved_key"
  ON "wiki_address_history" ("owner_user_id", "name_key", "variant")
  WHERE "reserved" AND "owner_user_id" IS NOT NULL;
CREATE UNIQUE INDEX "wiki_address_history_commons_reserved_key"
  ON "wiki_address_history" ("name_key", "variant")
  WHERE "reserved" AND "owner_user_id" IS NULL;
