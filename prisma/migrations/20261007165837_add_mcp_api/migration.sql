-- CreateEnum
CREATE TYPE "api_scope" AS ENUM ('READ', 'WRITE', 'MANAGE');

-- CreateEnum
CREATE TYPE "api_token_client" AS ENUM ('CLAUDE_CODE', 'CLAUDE_AI', 'OTHER');

-- CreateEnum
CREATE TYPE "api_write_state" AS ENUM ('RUNNING', 'DONE', 'FAILED');

-- AlterTable
ALTER TABLE "doc" ADD COLUMN     "import_key" TEXT,
ADD COLUMN     "imported_update_id" BIGINT,
ADD COLUMN     "record" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "file" ADD COLUMN     "outline" JSONB,
ADD COLUMN     "page_labels" JSONB;

-- CreateTable
CREATE TABLE "tag_slug_history" (
    "id" TEXT NOT NULL,
    "tag_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tag_slug_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_token" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "scopes" "api_scope"[],
    "client" "api_token_client" NOT NULL DEFAULT 'OTHER',
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),
    "created_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_write" (
    "id" TEXT NOT NULL,
    "token_id" TEXT NOT NULL,
    "key" TEXT,
    "operation" TEXT NOT NULL,
    "state" "api_write_state" NOT NULL DEFAULT 'RUNNING',
    "result" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "api_write_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tag_slug_history_slug_key" ON "tag_slug_history"("slug");

-- CreateIndex
CREATE INDEX "tag_slug_history_tag_id_idx" ON "tag_slug_history"("tag_id");

-- CreateIndex
CREATE UNIQUE INDEX "api_token_token_hash_key" ON "api_token"("token_hash");

-- CreateIndex
CREATE INDEX "api_token_user_id_idx" ON "api_token"("user_id");

-- CreateIndex
CREATE INDEX "api_write_token_id_created_at_idx" ON "api_write"("token_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "api_write_token_id_key_key" ON "api_write"("token_id", "key");

-- CreateIndex
CREATE INDEX "doc_import_key_idx" ON "doc"("import_key");

-- AddForeignKey
ALTER TABLE "tag_slug_history" ADD CONSTRAINT "tag_slug_history_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_token" ADD CONSTRAINT "api_token_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_token" ADD CONSTRAINT "api_token_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_write" ADD CONSTRAINT "api_write_token_id_fkey" FOREIGN KEY ("token_id") REFERENCES "api_token"("id") ON DELETE CASCADE ON UPDATE CASCADE;
