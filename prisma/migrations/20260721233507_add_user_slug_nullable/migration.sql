-- AlterTable
ALTER TABLE "User" ADD COLUMN     "slug" TEXT;

-- CreateTable
CREATE TABLE "UserSlugHistory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserSlugHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_slug_key" ON "User"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "UserSlugHistory_slug_key" ON "UserSlugHistory"("slug");

-- CreateIndex
CREATE INDEX "UserSlugHistory_userId_idx" ON "UserSlugHistory"("userId");

-- AddForeignKey
ALTER TABLE "UserSlugHistory" ADD CONSTRAINT "UserSlugHistory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
