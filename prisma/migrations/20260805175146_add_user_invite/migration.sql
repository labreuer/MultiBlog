-- CreateTable
CREATE TABLE "user_invite" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "invited_by_id" TEXT NOT NULL,
    "token" TEXT,
    "token_hash" TEXT NOT NULL,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "clicked_at" TIMESTAMP(3),
    "accepted_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "user_invite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_invite_token_hash_key" ON "user_invite"("token_hash");

-- CreateIndex
CREATE INDEX "user_invite_user_id_sent_at_idx" ON "user_invite"("user_id", "sent_at");

-- AddForeignKey
ALTER TABLE "user_invite" ADD CONSTRAINT "user_invite_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_invite" ADD CONSTRAINT "user_invite_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
