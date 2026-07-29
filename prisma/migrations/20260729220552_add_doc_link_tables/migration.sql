-- CreateTable
CREATE TABLE "doc_link" (
    "id" TEXT NOT NULL,
    "doc_id" TEXT NOT NULL,
    "mark_id" TEXT,
    "mark" JSONB,
    "text" TEXT,
    "doc_link_group_id" TEXT NOT NULL,
    "override_color" TEXT,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "doc_link_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doc_link_group" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "text" TEXT,
    "override_color" TEXT,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "doc_link_group_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "doc_link_doc_id_idx" ON "doc_link"("doc_id");

-- CreateIndex
CREATE INDEX "doc_link_doc_link_group_id_idx" ON "doc_link"("doc_link_group_id");

-- CreateIndex
CREATE INDEX "doc_link_group_user_id_idx" ON "doc_link_group"("user_id");

-- AddForeignKey
ALTER TABLE "doc_link" ADD CONSTRAINT "doc_link_doc_id_fkey" FOREIGN KEY ("doc_id") REFERENCES "doc"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doc_link" ADD CONSTRAINT "doc_link_doc_link_group_id_fkey" FOREIGN KEY ("doc_link_group_id") REFERENCES "doc_link_group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doc_link" ADD CONSTRAINT "doc_link_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doc_link_group" ADD CONSTRAINT "doc_link_group_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-added (Prisma has no CHECK-constraint DSL) — PLAN.md §14b: mark_id is
-- the reserved-but-unused inline-mark anchor, mark is the external anchor
-- this section actually builds, and exactly one is ever non-null. Without
-- this, mark_id is an untested column with no writer, which makes shipping
-- both columns honest rather than aspirational.
ALTER TABLE "doc_link" ADD CONSTRAINT "doc_link_exactly_one_anchor" CHECK (num_nonnulls("mark_id", "mark") = 1);
