-- CreateEnum
CREATE TYPE "email_collision_source" AS ENUM ('SIGNED_OUT_COMMENT', 'SIGNED_IN_COMMENT', 'EXISTING');

-- DropIndex
DROP INDEX "commenter_email_key";

-- CreateTable
CREATE TABLE "email_collision" (
    "id" TEXT NOT NULL,
    "source" "email_collision_source" NOT NULL,
    "email" TEXT NOT NULL,
    "user_id" TEXT,
    "commenter_id" TEXT,
    "post_id" TEXT,
    "last_ip_address" TEXT,
    "ip_addresses" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "count" INTEGER NOT NULL DEFAULT 1,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_at" TIMESTAMP(3),
    "reviewed_by_id" TEXT,

    CONSTRAINT "email_collision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "email_collision_user_id_idx" ON "email_collision"("user_id");

-- CreateIndex
CREATE INDEX "email_collision_commenter_id_idx" ON "email_collision"("commenter_id");

-- CreateIndex
CREATE INDEX "email_collision_post_id_idx" ON "email_collision"("post_id");

-- AddForeignKey
ALTER TABLE "email_collision" ADD CONSTRAINT "email_collision_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_collision" ADD CONSTRAINT "email_collision_commenter_id_fkey" FOREIGN KEY ("commenter_id") REFERENCES "commenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_collision" ADD CONSTRAINT "email_collision_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "post"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_collision" ADD CONSTRAINT "email_collision_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Hand-written from here: Prisma has no DSL for a partial or expression
-- index, a CHECK, or a view's body. docs/COMMENTS.md, "Identities kept apart".

-- An anonymous identity is found by its email among anonymous identities
-- only; a signed-in one by its user alone. So the email is unique only where
-- there is no user, and a signed-in row may share its email with an anonymous
-- one. Every existing row satisfies this, since it is a subset of the unique
-- index dropped above.
CREATE UNIQUE INDEX "commenter_anonymous_email_key"
  ON "commenter" ("email")
  WHERE "user_id" IS NULL;

-- Repeats fold into one unreviewed row per source and lowercased email,
-- whatever the IP address: src/lib/email-collision-log.ts's
-- `INSERT … ON CONFLICT` names exactly this index's columns and predicate.
-- Marking a row reviewed takes it out of the index, so the next meeting
-- starts a new row.
CREATE UNIQUE INDEX "email_collision_unreviewed_key"
  ON "email_collision" ("source", lower("email"))
  WHERE "reviewed_at" IS NULL;

ALTER TABLE "email_collision"
  ADD CONSTRAINT "email_collision_ip_addresses_bounded" CHECK (cardinality("ip_addresses") <= 20),
  ADD CONSTRAINT "email_collision_count_positive" CHECK ("count" >= 1);

-- What /email-collisions sorts and shows beyond the row's own columns, keyed
-- 1:1 on the row (CLAUDE.md, "Admin tables are one kit"). The comments' IP
-- addresses are read live from `comment.ip_address`, so nothing is copied:
-- the anonymous identity's, and the account's commenter row's (found by its
-- user, since the account's row is never the one `commenter_id` names). A
-- deleted comment still counts as a trace of who was there, so neither side
-- filters on `deleted_by_user_id`.
CREATE VIEW "email_collision_listing" AS
SELECT
  ec.id AS email_collision_id,
  (SELECT count(*)::integer FROM "comment" c WHERE c.commenter_id = ec.commenter_id) AS anonymous_comments,
  (
    SELECT string_agg(DISTINCT c.ip_address, ', ' ORDER BY c.ip_address)
    FROM "comment" c
    WHERE c.commenter_id = ec.commenter_id AND c.ip_address IS NOT NULL
  ) AS anonymous_ips,
  (
    SELECT string_agg(DISTINCT c.ip_address, ', ' ORDER BY c.ip_address)
    FROM "comment" c
    JOIN "commenter" cm ON cm.id = c.commenter_id
    WHERE cm.user_id = ec.user_id AND c.ip_address IS NOT NULL
  ) AS account_ips,
  NULLIF(array_to_string(ec.ip_addresses, ', '), '') AS request_ips
FROM "email_collision" ec;
