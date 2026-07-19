-- AlterTable
ALTER TABLE "User" ADD COLUMN     "color" TEXT NOT NULL DEFAULT '#5b8cff';

-- CreateTable
CREATE TABLE "PostCollabUpdate" (
    "id" BIGSERIAL NOT NULL,
    "postId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "update" BYTEA NOT NULL,

    CONSTRAINT "PostCollabUpdate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PostCollabUpdate_postId_id_idx" ON "PostCollabUpdate"("postId", "id");

-- AddForeignKey
ALTER TABLE "PostCollabUpdate" ADD CONSTRAINT "PostCollabUpdate_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;
