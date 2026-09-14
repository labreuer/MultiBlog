-- DropIndex
DROP INDEX "file_slug_key";

-- CreateIndex
CREATE INDEX "file_slug_idx" ON "file"("slug");

-- Hand-written below this line (the add_anchored_links convention — appended
-- to the --create-only SQL before first apply; Prisma has no partial-index
-- DSL). PLAN.md §19.

-- A file's slug is unique among *live* files only. Deleting a PDF releases
-- its url, so re-uploading a corrected copy of `report.pdf` is `report` again
-- rather than `report-2` forever; two soft-deleted files may share a slug,
-- which is why nothing looks a file up with findUnique on it any more
-- (src/lib/file-slug.ts's resolveFileParam prefers the live row). Restoring a
-- file whose slug was taken in the meantime renames it rather than failing
-- here — this index is the thing that makes that collision a real state to
-- handle rather than an impossible one (src/app/actions/files.ts).
CREATE UNIQUE INDEX "file_slug_live_key"
  ON "file" ("slug")
  WHERE "deleted_by_user_id" IS NULL;
