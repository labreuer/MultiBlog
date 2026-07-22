-- CreateTable
CREATE TABLE "PostSlugHistory" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PostSlugHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PostSlugHistory_slug_key" ON "PostSlugHistory"("slug");

-- CreateIndex
CREATE INDEX "PostSlugHistory_postId_idx" ON "PostSlugHistory"("postId");

-- AddForeignKey
ALTER TABLE "PostSlugHistory" ADD CONSTRAINT "PostSlugHistory_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;
