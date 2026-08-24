-- CreateTable
CREATE TABLE "file" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "page_count" INTEGER,
    "visibility" "doc_visibility" NOT NULL DEFAULT 'PRIVATE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_user_id" TEXT,
    "deleted_by_user_id" TEXT,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "file_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_owner" (
    "file_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "owner_order" INTEGER NOT NULL,

    CONSTRAINT "file_owner_pkey" PRIMARY KEY ("file_id","user_id")
);

-- CreateTable
CREATE TABLE "file_slug_history" (
    "id" TEXT NOT NULL,
    "file_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "file_slug_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_page_text" (
    "file_id" TEXT NOT NULL,
    "page_index" INTEGER NOT NULL,
    "text_version" TEXT NOT NULL,
    "text" TEXT NOT NULL,

    CONSTRAINT "file_page_text_pkey" PRIMARY KEY ("file_id","page_index","text_version")
);

-- CreateIndex
CREATE UNIQUE INDEX "file_slug_key" ON "file"("slug");

-- CreateIndex
CREATE INDEX "file_sha256_idx" ON "file"("sha256");

-- CreateIndex
CREATE UNIQUE INDEX "file_slug_history_slug_key" ON "file_slug_history"("slug");

-- CreateIndex
CREATE INDEX "file_slug_history_file_id_idx" ON "file_slug_history"("file_id");

-- AddForeignKey
ALTER TABLE "file" ADD CONSTRAINT "file_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file" ADD CONSTRAINT "file_deleted_by_user_id_fkey" FOREIGN KEY ("deleted_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_owner" ADD CONSTRAINT "file_owner_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "file"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_owner" ADD CONSTRAINT "file_owner_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_slug_history" ADD CONSTRAINT "file_slug_history_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "file"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_page_text" ADD CONSTRAINT "file_page_text_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "file"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- /files' Owner(s) column, as a view — the same role doc_metrics plays for
-- /docs, and built the same way for the same reason: by grouping file_owner,
-- never by selecting FROM file. A view that reads its own base table gets
-- scanned twice on every sort through it, because Prisma emits a LEFT JOIN for
-- a to-one relation ordering and Postgres 18's self-join elimination only
-- collapses INNER joins (add_doc_metrics_view, PLAN.md §16l).
--
-- Owners is here because a string_agg across a to-many is not something a plain
-- ORDER BY can name. Size and Pages are not: they are stored columns on file,
-- known once at upload and never recomputed, so they need neither a view nor a
-- trigger (the difference from /docs' Length, PLAN.md §16l).
--
-- A file nobody owns has no row here at all, which the caller reads as the
-- empty byline (src/app/files/page.tsx). The annotation count /files also
-- shows arrives with PDF annotations, which drop and recreate this view then;
-- it cannot be here yet because annotation.file_id does not exist until then.
CREATE VIEW file_metrics AS
SELECT fo.file_id,
       string_agg(u.admin_initials, ', ' ORDER BY fo.owner_order) AS owners
FROM file_owner fo
JOIN "user" u ON u.id = fo.user_id
GROUP BY fo.file_id;
