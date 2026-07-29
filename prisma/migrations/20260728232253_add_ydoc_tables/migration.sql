-- CreateTable
CREATE TABLE "ydoc" (
    "id" TEXT NOT NULL,
    "ydoc" BYTEA NOT NULL,
    "state_vector" BYTEA NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ydoc_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ydoc_update" (
    "id" BIGSERIAL NOT NULL,
    "ydoc_id" TEXT NOT NULL,
    "update" BYTEA NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ydoc_update_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ydoc_snapshot" (
    "id" TEXT NOT NULL,
    "ydoc_id" TEXT NOT NULL,
    "ydoc" BYTEA NOT NULL,
    "state_vector" BYTEA NOT NULL,
    "last_ydoc_update_id" BIGINT NOT NULL,
    "user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ydoc_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ydoc_updated_at_idx" ON "ydoc"("updated_at");

-- CreateIndex
CREATE INDEX "ydoc_update_ydoc_id_id_idx" ON "ydoc_update"("ydoc_id", "id");

-- CreateIndex
CREATE INDEX "ydoc_snapshot_ydoc_id_last_ydoc_update_id_idx" ON "ydoc_snapshot"("ydoc_id", "last_ydoc_update_id");

-- AddForeignKey
ALTER TABLE "ydoc_update" ADD CONSTRAINT "ydoc_update_ydoc_id_fkey" FOREIGN KEY ("ydoc_id") REFERENCES "ydoc"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ydoc_snapshot" ADD CONSTRAINT "ydoc_snapshot_ydoc_id_fkey" FOREIGN KEY ("ydoc_id") REFERENCES "ydoc"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ydoc_snapshot" ADD CONSTRAINT "ydoc_snapshot_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
