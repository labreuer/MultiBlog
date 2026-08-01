-- Baseline migration replacing the 10 migrations from 20260722184542_init
-- through 20260730193531_posts_become_doc_snapshots. Generated via
-- `prisma migrate diff --from-empty --to-schema prisma/schema.prisma`, with
-- one hand-added piece the diff cannot produce (see the CHECK constraint at
-- the end of this file — Prisma's schema DSL has no CHECK syntax, so a pure
-- schema diff would silently drop it).
--
-- Verified equivalent to the replaced history before deleting it: applied
-- both the old 10-migration sequence and this file to separate throwaway
-- databases and diffed live — 166 columns, 62 constraints (CHECK included),
-- 49 indexes, and every enum's label ordering matched exactly. The one
-- difference found (pg_enum.enumsortorder using fractional values on the old
-- side vs. clean integers here, from ALTER TYPE ... ADD VALUE BEFORE vs. a
-- fresh CREATE TYPE) is cosmetic: relative ordering was identical, and
-- ROLE_ORDER doesn't read the enum's ordinal position anyway (PLAN.md).
--
-- Any database that already ran the old migrations must NOT run this one —
-- it must be marked applied instead:
--   npx prisma migrate resolve --applied 20260801150314_baseline
-- Only a genuinely fresh database should run this file for real, via the
-- ordinary `prisma migrate deploy`.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "role" AS ENUM ('ADMIN', 'EDITOR', 'AUTHOR', 'AUTHORIZED', 'COMMENTER');

-- CreateEnum
CREATE TYPE "moderation_policy" AS ENUM ('INHERIT', 'ALWAYS', 'AUTO');

-- CreateEnum
CREATE TYPE "publication_event_type" AS ENUM ('PUBLISHED', 'UNPUBLISHED', 'SCHEDULED', 'SCHEDULE_CANCELED');

-- CreateEnum
CREATE TYPE "thread_status" AS ENUM ('ACTIVE', 'DETACHED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "comment_status" AS ENUM ('PENDING', 'APPROVED', 'SPAM', 'DELETED');

-- CreateEnum
CREATE TYPE "doc_visibility" AS ENUM ('PRIVATE', 'SHARED');

-- CreateEnum
CREATE TYPE "annotation_status" AS ENUM ('DRAFT', 'LIVE', 'RAISED');

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "email_verified" TIMESTAMP(3),
    "name" TEXT,
    "image" TEXT,
    "password_hash" TEXT,
    "role" "role" NOT NULL DEFAULT 'COMMENTER',
    "moderation_policy" "moderation_policy" NOT NULL DEFAULT 'INHERIT',
    "color" TEXT NOT NULL DEFAULT '#5b8cff',
    "admin_initials" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_by_user_id" TEXT,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_slug_history" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_slug_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_account_id" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" TEXT NOT NULL,
    "session_token" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_token" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "password_reset_token" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "doc_id" TEXT NOT NULL,
    "prose_json" JSONB,
    "publish_event_id" TEXT,
    "moderation_policy" "moderation_policy" NOT NULL DEFAULT 'INHERIT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMP(3),
    "deleted_by_user_id" TEXT,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "post_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_slug_history" (
    "id" TEXT NOT NULL,
    "post_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_slug_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_author" (
    "post_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "byline_order" INTEGER NOT NULL,
    "created_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_author_pkey" PRIMARY KEY ("post_id","user_id")
);

-- CreateTable
CREATE TABLE "post_publication_event" (
    "id" TEXT NOT NULL,
    "post_id" TEXT NOT NULL,
    "type" "publication_event_type" NOT NULL,
    "doc_id" TEXT,
    "ydoc_snapshot_id" TEXT,
    "title" TEXT,
    "prose_json" JSONB,
    "scheduled_for" TIMESTAMP(3),
    "actor_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_publication_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "default_moderation_policy" "moderation_policy" NOT NULL DEFAULT 'ALWAYS',
    "trust_threshold" INTEGER NOT NULL DEFAULT 3,

    CONSTRAINT "site_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commenter" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "email" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "approved_count" INTEGER NOT NULL DEFAULT 0,
    "force_moderate" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "commenter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comment_thread" (
    "id" TEXT NOT NULL,
    "post_id" TEXT NOT NULL,
    "anchored_event_id" TEXT NOT NULL,
    "anchor_from" INTEGER NOT NULL,
    "anchor_to" INTEGER NOT NULL,
    "quoted_text" TEXT NOT NULL,
    "status" "thread_status" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comment_thread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comment" (
    "id" TEXT NOT NULL,
    "thread_id" TEXT NOT NULL,
    "parent_comment_id" TEXT,
    "commenter_id" TEXT NOT NULL,
    "body" JSONB NOT NULL,
    "status" "comment_status" NOT NULL DEFAULT 'PENDING',
    "ip_address" TEXT,
    "status_changed_by_id" TEXT,
    "status_changed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "edited_at" TIMESTAMP(3),
    "deleted_by_user_id" TEXT,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doc" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "visibility" "doc_visibility" NOT NULL DEFAULT 'PRIVATE',
    "prose_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_by_user_id" TEXT,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "doc_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doc_author" (
    "doc_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "byline_order" INTEGER NOT NULL,

    CONSTRAINT "doc_author_pkey" PRIMARY KEY ("doc_id","user_id")
);

-- CreateTable
CREATE TABLE "doc_slug_history" (
    "id" TEXT NOT NULL,
    "doc_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "doc_slug_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "annotation" (
    "id" TEXT NOT NULL,
    "doc_id" TEXT NOT NULL,
    "parent_annotation_id" TEXT,
    "user_id" TEXT NOT NULL,
    "prose_json" JSONB,
    "body_text" TEXT NOT NULL DEFAULT '',
    "status" "annotation_status" NOT NULL DEFAULT 'DRAFT',
    "raised_at" TIMESTAMP(3),
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "edited_at" TIMESTAMP(3),
    "deleted_by_user_id" TEXT,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "annotation_pkey" PRIMARY KEY ("id")
);

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
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "user_slug_key" ON "user"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "user_slug_history_slug_key" ON "user_slug_history"("slug");

-- CreateIndex
CREATE INDEX "user_slug_history_user_id_idx" ON "user_slug_history"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "account_provider_provider_account_id_key" ON "account"("provider", "provider_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "session_session_token_key" ON "session"("session_token");

-- CreateIndex
CREATE UNIQUE INDEX "verification_token_token_key" ON "verification_token"("token");

-- CreateIndex
CREATE UNIQUE INDEX "verification_token_identifier_token_key" ON "verification_token"("identifier", "token");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_token_token_hash_key" ON "password_reset_token"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "post_slug_key" ON "post"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "post_publish_event_id_key" ON "post"("publish_event_id");

-- CreateIndex
CREATE INDEX "post_doc_id_idx" ON "post"("doc_id");

-- CreateIndex
CREATE UNIQUE INDEX "post_slug_history_slug_key" ON "post_slug_history"("slug");

-- CreateIndex
CREATE INDEX "post_slug_history_post_id_idx" ON "post_slug_history"("post_id");

-- CreateIndex
CREATE INDEX "post_publication_event_post_id_created_at_idx" ON "post_publication_event"("post_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "commenter_user_id_key" ON "commenter"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "commenter_email_key" ON "commenter"("email");

-- CreateIndex
CREATE UNIQUE INDEX "doc_slug_key" ON "doc"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "doc_slug_history_slug_key" ON "doc_slug_history"("slug");

-- CreateIndex
CREATE INDEX "doc_slug_history_doc_id_idx" ON "doc_slug_history"("doc_id");

-- CreateIndex
CREATE INDEX "annotation_doc_id_idx" ON "annotation"("doc_id");

-- CreateIndex
CREATE INDEX "doc_link_doc_id_idx" ON "doc_link"("doc_id");

-- CreateIndex
CREATE INDEX "doc_link_doc_link_group_id_idx" ON "doc_link"("doc_link_group_id");

-- CreateIndex
CREATE INDEX "doc_link_group_user_id_idx" ON "doc_link_group"("user_id");

-- CreateIndex
CREATE INDEX "ydoc_updated_at_idx" ON "ydoc"("updated_at");

-- CreateIndex
CREATE INDEX "ydoc_update_ydoc_id_id_idx" ON "ydoc_update"("ydoc_id", "id");

-- CreateIndex
CREATE INDEX "ydoc_snapshot_ydoc_id_last_ydoc_update_id_idx" ON "ydoc_snapshot"("ydoc_id", "last_ydoc_update_id");

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_deleted_by_user_id_fkey" FOREIGN KEY ("deleted_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_slug_history" ADD CONSTRAINT "user_slug_history_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_token" ADD CONSTRAINT "password_reset_token_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post" ADD CONSTRAINT "post_doc_id_fkey" FOREIGN KEY ("doc_id") REFERENCES "doc"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post" ADD CONSTRAINT "post_publish_event_id_fkey" FOREIGN KEY ("publish_event_id") REFERENCES "post_publication_event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post" ADD CONSTRAINT "post_deleted_by_user_id_fkey" FOREIGN KEY ("deleted_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_slug_history" ADD CONSTRAINT "post_slug_history_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_author" ADD CONSTRAINT "post_author_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_author" ADD CONSTRAINT "post_author_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_author" ADD CONSTRAINT "post_author_created_user_id_fkey" FOREIGN KEY ("created_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_publication_event" ADD CONSTRAINT "post_publication_event_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_publication_event" ADD CONSTRAINT "post_publication_event_doc_id_fkey" FOREIGN KEY ("doc_id") REFERENCES "doc"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_publication_event" ADD CONSTRAINT "post_publication_event_ydoc_snapshot_id_fkey" FOREIGN KEY ("ydoc_snapshot_id") REFERENCES "ydoc_snapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_publication_event" ADD CONSTRAINT "post_publication_event_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commenter" ADD CONSTRAINT "commenter_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_thread" ADD CONSTRAINT "comment_thread_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_thread" ADD CONSTRAINT "comment_thread_anchored_event_id_fkey" FOREIGN KEY ("anchored_event_id") REFERENCES "post_publication_event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment" ADD CONSTRAINT "comment_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "comment_thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment" ADD CONSTRAINT "comment_parent_comment_id_fkey" FOREIGN KEY ("parent_comment_id") REFERENCES "comment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment" ADD CONSTRAINT "comment_commenter_id_fkey" FOREIGN KEY ("commenter_id") REFERENCES "commenter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment" ADD CONSTRAINT "comment_status_changed_by_id_fkey" FOREIGN KEY ("status_changed_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment" ADD CONSTRAINT "comment_deleted_by_user_id_fkey" FOREIGN KEY ("deleted_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doc" ADD CONSTRAINT "doc_deleted_by_user_id_fkey" FOREIGN KEY ("deleted_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doc_author" ADD CONSTRAINT "doc_author_doc_id_fkey" FOREIGN KEY ("doc_id") REFERENCES "doc"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doc_author" ADD CONSTRAINT "doc_author_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doc_slug_history" ADD CONSTRAINT "doc_slug_history_doc_id_fkey" FOREIGN KEY ("doc_id") REFERENCES "doc"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "annotation" ADD CONSTRAINT "annotation_doc_id_fkey" FOREIGN KEY ("doc_id") REFERENCES "doc"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "annotation" ADD CONSTRAINT "annotation_parent_annotation_id_fkey" FOREIGN KEY ("parent_annotation_id") REFERENCES "annotation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "annotation" ADD CONSTRAINT "annotation_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "annotation" ADD CONSTRAINT "annotation_deleted_by_user_id_fkey" FOREIGN KEY ("deleted_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doc_link" ADD CONSTRAINT "doc_link_doc_id_fkey" FOREIGN KEY ("doc_id") REFERENCES "doc"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doc_link" ADD CONSTRAINT "doc_link_doc_link_group_id_fkey" FOREIGN KEY ("doc_link_group_id") REFERENCES "doc_link_group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doc_link" ADD CONSTRAINT "doc_link_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doc_link_group" ADD CONSTRAINT "doc_link_group_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ydoc_update" ADD CONSTRAINT "ydoc_update_ydoc_id_fkey" FOREIGN KEY ("ydoc_id") REFERENCES "ydoc"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ydoc_snapshot" ADD CONSTRAINT "ydoc_snapshot_ydoc_id_fkey" FOREIGN KEY ("ydoc_id") REFERENCES "ydoc"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ydoc_snapshot" ADD CONSTRAINT "ydoc_snapshot_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Hand-added (Prisma has no CHECK-constraint DSL) — PLAN.md §14b: mark_id is
-- the reserved-but-unused inline-mark anchor, mark is the external anchor
-- this section actually builds, and exactly one is ever non-null. Without
-- this, mark_id is an untested column with no writer, which makes shipping
-- both columns honest rather than aspirational.
ALTER TABLE "doc_link" ADD CONSTRAINT "doc_link_exactly_one_anchor" CHECK (num_nonnulls("mark_id", "mark") = 1);
