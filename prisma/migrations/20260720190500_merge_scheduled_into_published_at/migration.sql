-- Hand-written: visibility is now gated by publishRevisionId + publishedAt
-- vs now() at query time, replacing the sweep + separate scheduledFor column.
--
-- Any post still mid-schedule under the old model (publishRevisionId null,
-- scheduledFor set) must carry that forward correctly rather than silently
-- losing its pending schedule: point publishRevisionId at its latest
-- revision (what scheduling now always does immediately) and move
-- scheduledFor's value into publishedAt (the new single "when this goes/went
-- live" field) before the column is dropped.
UPDATE "Post" p
SET "publishRevisionId" = (
      SELECT r.id FROM "Revision" r
      WHERE r."postId" = p.id
      ORDER BY r."revisionNumber" DESC
      LIMIT 1
    ),
    "publishedAt" = p."scheduledFor"
WHERE p."scheduledFor" IS NOT NULL AND p."publishRevisionId" IS NULL;

ALTER TABLE "Post" DROP COLUMN "scheduledFor";
