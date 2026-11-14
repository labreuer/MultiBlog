-- docs/PDF.md §13, "Matching the pages" — a version's page map: for each
-- sheet of its base, a sheet of this version or none, as one JSON value, with
-- who stored it, when, and the bulk carry that did, where one did.
--
-- NULL until a deliberate act stores one, and stored once. Every version
-- that exists when this runs has none, so every link into a file with
-- several versions goes on opening the version it names until a manager asks
-- for a map.

-- AlterTable
ALTER TABLE "file_version" ADD COLUMN     "page_map" JSONB,
ADD COLUMN     "page_map_carry_id" TEXT,
ADD COLUMN     "page_map_stored_at" TIMESTAMP(3),
ADD COLUMN     "page_map_stored_by_user_id" TEXT;

-- AddForeignKey
ALTER TABLE "file_version" ADD CONSTRAINT "file_version_page_map_stored_by_user_id_fkey" FOREIGN KEY ("page_map_stored_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A map and the moment it was stored are written together. Hand-written:
-- Prisma has no DSL for a CHECK.
ALTER TABLE "file_version" ADD CONSTRAINT "file_version_page_map_stored_check"
    CHECK (("page_map" IS NULL) = ("page_map_stored_at" IS NULL));
