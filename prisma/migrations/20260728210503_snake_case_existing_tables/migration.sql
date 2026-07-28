/*
  Warnings:

  - You are about to drop the `Account` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Comment` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `CommentThread` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Commenter` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `PasswordResetToken` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Post` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `PostAuthor` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `PostCollab` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `PostCollabUpdate` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `PostPublicationEvent` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `PostSlugHistory` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Revision` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Session` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `SiteSettings` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `User` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `UserSlugHistory` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `VerificationToken` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "role" AS ENUM ('ADMIN', 'EDITOR', 'AUTHOR', 'COMMENTER');

-- CreateEnum
CREATE TYPE "moderation_policy" AS ENUM ('INHERIT', 'ALWAYS', 'AUTO');

-- CreateEnum
CREATE TYPE "publication_event_type" AS ENUM ('PUBLISHED', 'UNPUBLISHED', 'SCHEDULED', 'SCHEDULE_CANCELED');

-- CreateEnum
CREATE TYPE "thread_status" AS ENUM ('ACTIVE', 'DETACHED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "comment_status" AS ENUM ('PENDING', 'APPROVED', 'SPAM', 'DELETED');

-- DropForeignKey
ALTER TABLE "Account" DROP CONSTRAINT "Account_userId_fkey";

-- DropForeignKey
ALTER TABLE "Comment" DROP CONSTRAINT "Comment_commenterId_fkey";

-- DropForeignKey
ALTER TABLE "Comment" DROP CONSTRAINT "Comment_deletedByUserId_fkey";

-- DropForeignKey
ALTER TABLE "Comment" DROP CONSTRAINT "Comment_parentCommentId_fkey";

-- DropForeignKey
ALTER TABLE "Comment" DROP CONSTRAINT "Comment_statusChangedById_fkey";

-- DropForeignKey
ALTER TABLE "Comment" DROP CONSTRAINT "Comment_threadId_fkey";

-- DropForeignKey
ALTER TABLE "CommentThread" DROP CONSTRAINT "CommentThread_anchoredRevisionId_fkey";

-- DropForeignKey
ALTER TABLE "CommentThread" DROP CONSTRAINT "CommentThread_postId_fkey";

-- DropForeignKey
ALTER TABLE "Commenter" DROP CONSTRAINT "Commenter_userId_fkey";

-- DropForeignKey
ALTER TABLE "PasswordResetToken" DROP CONSTRAINT "PasswordResetToken_userId_fkey";

-- DropForeignKey
ALTER TABLE "Post" DROP CONSTRAINT "Post_deletedByUserId_fkey";

-- DropForeignKey
ALTER TABLE "Post" DROP CONSTRAINT "Post_publishRevisionId_fkey";

-- DropForeignKey
ALTER TABLE "PostAuthor" DROP CONSTRAINT "PostAuthor_postId_fkey";

-- DropForeignKey
ALTER TABLE "PostAuthor" DROP CONSTRAINT "PostAuthor_userId_fkey";

-- DropForeignKey
ALTER TABLE "PostCollab" DROP CONSTRAINT "PostCollab_postId_fkey";

-- DropForeignKey
ALTER TABLE "PostCollabUpdate" DROP CONSTRAINT "PostCollabUpdate_postId_fkey";

-- DropForeignKey
ALTER TABLE "PostPublicationEvent" DROP CONSTRAINT "PostPublicationEvent_actorId_fkey";

-- DropForeignKey
ALTER TABLE "PostPublicationEvent" DROP CONSTRAINT "PostPublicationEvent_postId_fkey";

-- DropForeignKey
ALTER TABLE "PostPublicationEvent" DROP CONSTRAINT "PostPublicationEvent_revisionId_fkey";

-- DropForeignKey
ALTER TABLE "PostSlugHistory" DROP CONSTRAINT "PostSlugHistory_postId_fkey";

-- DropForeignKey
ALTER TABLE "Revision" DROP CONSTRAINT "Revision_editorId_fkey";

-- DropForeignKey
ALTER TABLE "Revision" DROP CONSTRAINT "Revision_postId_fkey";

-- DropForeignKey
ALTER TABLE "Session" DROP CONSTRAINT "Session_userId_fkey";

-- DropForeignKey
ALTER TABLE "User" DROP CONSTRAINT "User_deletedByUserId_fkey";

-- DropForeignKey
ALTER TABLE "UserSlugHistory" DROP CONSTRAINT "UserSlugHistory_userId_fkey";

-- DropTable
DROP TABLE "Account";

-- DropTable
DROP TABLE "Comment";

-- DropTable
DROP TABLE "CommentThread";

-- DropTable
DROP TABLE "Commenter";

-- DropTable
DROP TABLE "PasswordResetToken";

-- DropTable
DROP TABLE "Post";

-- DropTable
DROP TABLE "PostAuthor";

-- DropTable
DROP TABLE "PostCollab";

-- DropTable
DROP TABLE "PostCollabUpdate";

-- DropTable
DROP TABLE "PostPublicationEvent";

-- DropTable
DROP TABLE "PostSlugHistory";

-- DropTable
DROP TABLE "Revision";

-- DropTable
DROP TABLE "Session";

-- DropTable
DROP TABLE "SiteSettings";

-- DropTable
DROP TABLE "User";

-- DropTable
DROP TABLE "UserSlugHistory";

-- DropTable
DROP TABLE "VerificationToken";

-- DropEnum
DROP TYPE "CommentStatus";

-- DropEnum
DROP TYPE "ModerationPolicy";

-- DropEnum
DROP TYPE "PublicationEventType";

-- DropEnum
DROP TYPE "Role";

-- DropEnum
DROP TYPE "ThreadStatus";

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
    "publish_revision_id" TEXT,
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

    CONSTRAINT "post_author_pkey" PRIMARY KEY ("post_id","user_id")
);

-- CreateTable
CREATE TABLE "revision" (
    "id" TEXT NOT NULL,
    "post_id" TEXT NOT NULL,
    "revision_number" INTEGER NOT NULL,
    "doc" JSONB NOT NULL,
    "title" TEXT NOT NULL,
    "editor_id" TEXT,
    "changelog" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "revision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_publication_event" (
    "id" TEXT NOT NULL,
    "post_id" TEXT NOT NULL,
    "type" "publication_event_type" NOT NULL,
    "revision_id" TEXT,
    "scheduled_for" TIMESTAMP(3),
    "actor_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_publication_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_collab" (
    "post_id" TEXT NOT NULL,
    "ydoc" BYTEA NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "post_collab_pkey" PRIMARY KEY ("post_id")
);

-- CreateTable
CREATE TABLE "post_collab_update" (
    "id" BIGSERIAL NOT NULL,
    "post_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "update" BYTEA NOT NULL,

    CONSTRAINT "post_collab_update_pkey" PRIMARY KEY ("id")
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
    "anchored_revision_id" TEXT NOT NULL,
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
CREATE UNIQUE INDEX "post_publish_revision_id_key" ON "post"("publish_revision_id");

-- CreateIndex
CREATE UNIQUE INDEX "post_slug_history_slug_key" ON "post_slug_history"("slug");

-- CreateIndex
CREATE INDEX "post_slug_history_post_id_idx" ON "post_slug_history"("post_id");

-- CreateIndex
CREATE UNIQUE INDEX "revision_post_id_revision_number_key" ON "revision"("post_id", "revision_number");

-- CreateIndex
CREATE INDEX "post_publication_event_post_id_created_at_idx" ON "post_publication_event"("post_id", "created_at");

-- CreateIndex
CREATE INDEX "post_collab_update_post_id_id_idx" ON "post_collab_update"("post_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "commenter_user_id_key" ON "commenter"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "commenter_email_key" ON "commenter"("email");

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
ALTER TABLE "post" ADD CONSTRAINT "post_publish_revision_id_fkey" FOREIGN KEY ("publish_revision_id") REFERENCES "revision"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post" ADD CONSTRAINT "post_deleted_by_user_id_fkey" FOREIGN KEY ("deleted_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_slug_history" ADD CONSTRAINT "post_slug_history_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_author" ADD CONSTRAINT "post_author_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_author" ADD CONSTRAINT "post_author_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revision" ADD CONSTRAINT "revision_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revision" ADD CONSTRAINT "revision_editor_id_fkey" FOREIGN KEY ("editor_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_publication_event" ADD CONSTRAINT "post_publication_event_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_publication_event" ADD CONSTRAINT "post_publication_event_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "revision"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_publication_event" ADD CONSTRAINT "post_publication_event_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_collab" ADD CONSTRAINT "post_collab_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_collab_update" ADD CONSTRAINT "post_collab_update_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commenter" ADD CONSTRAINT "commenter_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_thread" ADD CONSTRAINT "comment_thread_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_thread" ADD CONSTRAINT "comment_thread_anchored_revision_id_fkey" FOREIGN KEY ("anchored_revision_id") REFERENCES "revision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

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
