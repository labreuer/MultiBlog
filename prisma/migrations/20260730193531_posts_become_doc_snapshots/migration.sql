-- DropForeignKey
ALTER TABLE "comment_thread" DROP CONSTRAINT "comment_thread_anchored_revision_id_fkey";

-- DropForeignKey
ALTER TABLE "post" DROP CONSTRAINT "post_publish_revision_id_fkey";

-- DropForeignKey
ALTER TABLE "post_collab" DROP CONSTRAINT "post_collab_post_id_fkey";

-- DropForeignKey
ALTER TABLE "post_collab_update" DROP CONSTRAINT "post_collab_update_post_id_fkey";

-- DropForeignKey
ALTER TABLE "post_publication_event" DROP CONSTRAINT "post_publication_event_revision_id_fkey";

-- DropForeignKey
ALTER TABLE "revision" DROP CONSTRAINT "revision_editor_id_fkey";

-- DropForeignKey
ALTER TABLE "revision" DROP CONSTRAINT "revision_post_id_fkey";

-- DropIndex
DROP INDEX "post_publish_revision_id_key";

-- AlterTable
ALTER TABLE "comment_thread" DROP COLUMN "anchored_revision_id",
ADD COLUMN     "anchored_event_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "post" DROP COLUMN "publish_revision_id",
ADD COLUMN     "doc_id" TEXT NOT NULL,
ADD COLUMN     "prose_json" JSONB,
ADD COLUMN     "publish_event_id" TEXT;

-- AlterTable
ALTER TABLE "post_author" ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "created_user_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "post_publication_event" DROP COLUMN "revision_id",
ADD COLUMN     "doc_id" TEXT,
ADD COLUMN     "prose_json" JSONB,
ADD COLUMN     "title" TEXT,
ADD COLUMN     "ydoc_snapshot_id" TEXT;

-- DropTable
DROP TABLE "post_collab";

-- DropTable
DROP TABLE "post_collab_update";

-- DropTable
DROP TABLE "revision";

-- CreateIndex
CREATE UNIQUE INDEX "post_publish_event_id_key" ON "post"("publish_event_id");

-- CreateIndex
CREATE INDEX "post_doc_id_idx" ON "post"("doc_id");

-- AddForeignKey
ALTER TABLE "post" ADD CONSTRAINT "post_doc_id_fkey" FOREIGN KEY ("doc_id") REFERENCES "doc"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post" ADD CONSTRAINT "post_publish_event_id_fkey" FOREIGN KEY ("publish_event_id") REFERENCES "post_publication_event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_author" ADD CONSTRAINT "post_author_created_user_id_fkey" FOREIGN KEY ("created_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_publication_event" ADD CONSTRAINT "post_publication_event_doc_id_fkey" FOREIGN KEY ("doc_id") REFERENCES "doc"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_publication_event" ADD CONSTRAINT "post_publication_event_ydoc_snapshot_id_fkey" FOREIGN KEY ("ydoc_snapshot_id") REFERENCES "ydoc_snapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_thread" ADD CONSTRAINT "comment_thread_anchored_event_id_fkey" FOREIGN KEY ("anchored_event_id") REFERENCES "post_publication_event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

