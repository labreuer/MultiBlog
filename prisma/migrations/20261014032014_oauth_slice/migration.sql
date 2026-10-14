-- AlterTable
ALTER TABLE "api_token" ADD COLUMN     "oauth_client_id" TEXT,
ALTER COLUMN "token_hash" DROP NOT NULL;

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "works_for_user_id" TEXT;

-- CreateTable
CREATE TABLE "oauth_client" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "redirect_uris" TEXT[],
    "client" "api_token_client" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "oauth_client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_authorization_code" (
    "id" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "redirect_uri" TEXT NOT NULL,
    "code_challenge" TEXT NOT NULL,
    "scopes" "api_scope"[],
    "user_id" TEXT NOT NULL,
    "issuer_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "api_token_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_authorization_code_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "oauth_authorization_code_code_hash_key" ON "oauth_authorization_code"("code_hash");

-- CreateIndex
CREATE INDEX "oauth_authorization_code_expires_at_idx" ON "oauth_authorization_code"("expires_at");

-- CreateIndex
CREATE INDEX "user_works_for_user_id_idx" ON "user"("works_for_user_id");

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_works_for_user_id_fkey" FOREIGN KEY ("works_for_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_authorization_code" ADD CONSTRAINT "oauth_authorization_code_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_authorization_code" ADD CONSTRAINT "oauth_authorization_code_issuer_id_fkey" FOREIGN KEY ("issuer_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_authorization_code" ADD CONSTRAINT "oauth_authorization_code_api_token_id_fkey" FOREIGN KEY ("api_token_id") REFERENCES "api_token"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Hand-written from here: the CHECKs, which Prisma has no DSL for.
-- docs/MCP.md §21, "A connection", "Whose account" and "Which clients".

-- A row is a header token or an OAuth connection: a secret's hash, or the
-- client_id the connection was made through, one and never both.
ALTER TABLE "api_token"
  ADD CONSTRAINT "api_token_kind_check"
  CHECK (("token_hash" IS NULL) <> ("oauth_client_id" IS NULL));

-- A bot has no password. Sign-in is by password alone, so a password is what
-- makes an account a person's, and a person never works for anyone: if one
-- could, a second person could connect as the first and read their PRIVATE
-- docs. An ADMIN's invite is how a bot would get one later.
ALTER TABLE "user"
  ADD CONSTRAINT "user_bot_has_no_password_check"
  CHECK ("works_for_user_id" IS NULL OR "password_hash" IS NULL);

-- OAuth never issues a claude-code token: a client's claim to be Claude Code
-- rests on a loopback redirect, which any program on the machine can answer.
ALTER TABLE "oauth_client"
  ADD CONSTRAINT "oauth_client_kind_check"
  CHECK ("client" <> 'CLAUDE_CODE');
