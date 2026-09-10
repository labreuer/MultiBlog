-- AlterTable
ALTER TABLE "anchored_link" ADD COLUMN     "name" TEXT;

-- Hand-written below this line (the add_anchored_links convention — appended
-- to the --create-only SQL before first apply; Prisma has no CHECK DSL).
-- docs/ANCHORED_LINKS.md, "Naming a link".

-- A name is null or a name, never blank. The writer already stores
-- whitespace-only input as null (normalizeLinkName, src/lib/anchored-link-
-- editing.ts); this keeps any other writer honest, so every reader's
-- `name ?? "Linked passages"` is the whole fallback and no surface needs a
-- second "or blank" check.
ALTER TABLE "anchored_link"
  ADD CONSTRAINT "anchored_link_name_not_blank_check"
  CHECK ("name" IS NULL OR btrim("name") <> '');
