-- AlterTable
ALTER TABLE "user" ADD COLUMN     "contributor_blurb" JSONB,
ADD COLUMN     "contributor_order" INTEGER,
ADD COLUMN     "is_listed_contributor" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "orcid" TEXT,
ADD COLUMN     "website" TEXT;

-- Backfill (PLAN.md §17e): list every user with at least one live published
-- post at the moment this migration runs, so the contributor list isn't
-- empty on day one. Both deleted_by_user_id checks are spelled out by hand
-- because raw SQL sits outside src/lib/prisma.ts's soft-delete extension.
UPDATE "user" u SET is_listed_contributor = true
WHERE u.deleted_by_user_id IS NULL
  AND EXISTS (SELECT 1 FROM post_author pa JOIN post p ON p.id = pa.post_id
              WHERE pa.user_id = u.id AND p.deleted_by_user_id IS NULL
                AND p.publish_event_id IS NOT NULL AND p.published_at <= now());
