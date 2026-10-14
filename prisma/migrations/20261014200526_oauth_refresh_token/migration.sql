-- CreateTable
CREATE TABLE "oauth_refresh_token" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "api_token_id" TEXT NOT NULL,
    "parent_id" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_refresh_token_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "oauth_refresh_token_token_hash_key" ON "oauth_refresh_token"("token_hash");

-- CreateIndex
CREATE INDEX "oauth_refresh_token_api_token_id_idx" ON "oauth_refresh_token"("api_token_id");

-- CreateIndex
CREATE INDEX "oauth_refresh_token_parent_id_idx" ON "oauth_refresh_token"("parent_id");

-- CreateIndex
CREATE INDEX "oauth_refresh_token_expires_at_idx" ON "oauth_refresh_token"("expires_at");

-- AddForeignKey
ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_api_token_id_fkey" FOREIGN KEY ("api_token_id") REFERENCES "api_token"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-written from here. docs/MCP.md §21, "Seeing and ending a connection".

-- The thin slice's connections end here. They have no refresh token, and a
-- connection lapses when its newest one expires, so they would otherwise
-- show as live for good. Each lasted its access token's hour anyway, and
-- claude.ai connects again on the 401 its next call gets. In UTC, as Prisma
-- writes every timestamp.
UPDATE "api_token"
SET "revoked_at" = now() AT TIME ZONE 'UTC'
WHERE "oauth_client_id" IS NOT NULL AND "revoked_at" IS NULL;
