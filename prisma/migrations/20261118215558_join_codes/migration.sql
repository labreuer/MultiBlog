-- AlterTable
ALTER TABLE "commenter" ADD COLUMN     "trusted" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "email_collision" ADD COLUMN     "claim_ip_address" TEXT,
ADD COLUMN     "join_code_id" TEXT;

-- CreateTable
CREATE TABLE "join_batch" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "join_batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "join_code" (
    "id" TEXT NOT NULL,
    "batch_id" TEXT NOT NULL,
    "serial" INTEGER NOT NULL,
    "code_hash" TEXT NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "pending_email" TEXT,
    "pending_name" TEXT,
    "pending_password_hash" TEXT,
    "pending_ip_address" TEXT,
    "confirm_token_hash" TEXT,
    "confirm_sent_at" TIMESTAMP(3),
    "confirm_sends" INTEGER NOT NULL DEFAULT 0,
    "confirm_failures" INTEGER NOT NULL DEFAULT 0,
    "claimed_at" TIMESTAMP(3),
    "claimed_user_id" TEXT,

    CONSTRAINT "join_code_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "join_code_code_hash_key" ON "join_code"("code_hash");

-- CreateIndex
CREATE UNIQUE INDEX "join_code_confirm_token_hash_key" ON "join_code"("confirm_token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "join_code_claimed_user_id_key" ON "join_code"("claimed_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "join_code_batch_id_serial_key" ON "join_code"("batch_id", "serial");

-- CreateIndex
CREATE INDEX "email_collision_join_code_id_idx" ON "email_collision"("join_code_id");

-- AddForeignKey
ALTER TABLE "join_batch" ADD CONSTRAINT "join_batch_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "join_code" ADD CONSTRAINT "join_code_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "join_batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "join_code" ADD CONSTRAINT "join_code_claimed_user_id_fkey" FOREIGN KEY ("claimed_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_collision" ADD CONSTRAINT "email_collision_join_code_id_fkey" FOREIGN KEY ("join_code_id") REFERENCES "join_code"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Hand-written from here: Prisma has no DSL for a CHECK. docs/EMAIL.md §10,
-- "The data".

-- A pending claim is its email, name, password hash and confirmation token
-- together, or none of them; its IP address may be unknown, and
-- confirm_sent_at stays null until a send is delivered.
ALTER TABLE "join_code"
  ADD CONSTRAINT "join_code_pending_claim_whole" CHECK (
    ("pending_email" IS NULL) = ("pending_name" IS NULL)
    AND ("pending_email" IS NULL) = ("pending_password_hash" IS NULL)
    AND ("pending_email" IS NULL) = ("confirm_token_hash" IS NULL)
  ),
  -- A claimed card holds no pending claim: confirming nulls it, in the same
  -- statement that stamps claimed_at.
  ADD CONSTRAINT "join_code_claimed_has_no_claim" CHECK (
    "claimed_at" IS NULL
    OR ("pending_email" IS NULL AND "pending_ip_address" IS NULL AND "confirm_token_hash" IS NULL)
  ),
  ADD CONSTRAINT "join_code_serial_positive" CHECK ("serial" >= 1),
  ADD CONSTRAINT "join_code_counts_nonnegative" CHECK ("confirm_sends" >= 0 AND "confirm_failures" >= 0);
