-- Hand-written (not `prisma migrate dev`, which refuses to run
-- non-interactively): renames + drops that a plain diff would otherwise
-- turn into drop+recreate, which would null out every already-published
-- post's live pointer.

-- 1. Rename Post.currentRevisionId -> publishRevisionId, preserving data,
--    the unique index, and the FK constraint.
ALTER TABLE "Post" RENAME COLUMN "currentRevisionId" TO "publishRevisionId";
ALTER INDEX "Post_currentRevisionId_key" RENAME TO "Post_publishRevisionId_key";
ALTER TABLE "Post" RENAME CONSTRAINT "Post_currentRevisionId_fkey" TO "Post_publishRevisionId_fkey";

-- 2. New field: scheduledFor.
ALTER TABLE "Post" ADD COLUMN "scheduledFor" TIMESTAMP(3);

-- 3. Drop status — every existing row already encodes the same information
--    via publishRevisionId (published iff non-null); no backfill needed.
ALTER TABLE "Post" DROP COLUMN "status";
DROP TYPE "PostStatus";

-- 4. Publication event log.
CREATE TYPE "PublicationEventType" AS ENUM ('PUBLISHED', 'UNPUBLISHED', 'SCHEDULED', 'SCHEDULE_CANCELED');

CREATE TABLE "PostPublicationEvent" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "type" "PublicationEventType" NOT NULL,
    "revisionId" TEXT,
    "scheduledFor" TIMESTAMP(3),
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PostPublicationEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PostPublicationEvent_postId_createdAt_idx" ON "PostPublicationEvent"("postId", "createdAt");

ALTER TABLE "PostPublicationEvent" ADD CONSTRAINT "PostPublicationEvent_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PostPublicationEvent" ADD CONSTRAINT "PostPublicationEvent_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "Revision"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PostPublicationEvent" ADD CONSTRAINT "PostPublicationEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
