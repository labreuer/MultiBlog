import { Prisma } from "@/generated/prisma/client";
import type { EmailCollisionSource } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";

// The log of where an account and an anonymous commenter meet on one email
// (docs/COMMENTS.md, "The log"), for an ADMIN to review at /email-collisions.
//
// **Repeats fold into one unreviewed row per source and lowercased email**,
// whatever the IP address: a refused comment makes no `comment` row, so the
// comment limiter never counts it, and a host with many addresses would make
// a row per address if the address were part of the key. A repeat counts,
// moves `last_seen_at`, sets `last_ip_address`, adds its address to
// `ip_addresses` while there are fewer than 20, and sets the three ids to its
// own. The fold is a raw `INSERT … ON CONFLICT`, since Prisma's `upsert` can
// target neither an expression nor a partial index; the conflict target names
// `email_collision_unreviewed_key`'s columns and predicate exactly.
//
// **A failed write changes no answer.** The caller has already decided, and
// this runs outside any transaction it has open: a failed statement aborts a
// Postgres transaction, so writing it inside one would undo what the
// transaction did. A failure is logged to the console and swallowed.
//
// `cuid()` has no SQL equivalent, so a raw insert's id is
// `gen_random_uuid()::text`, as the comment-revisions backfill's are. Its
// times are written `now() AT TIME ZONE 'UTC'`, never the column default or a
// bare `now()`: the columns are `timestamp without time zone` holding UTC, as
// Prisma writes them, and a raw statement gets the session's zone otherwise.
// The email stays as the first request gave it.

export type EmailCollisionMeeting = {
  source: EmailCollisionSource;
  /** As the request gave it. */
  email: string;
  /** The account with the email, or given it. */
  userId: string | null;
  /** The anonymous identity with the email, if there is one. */
  commenterId: string | null;
  /** The post a comment was tried on. */
  postId: string | null;
  ipAddress: string | null;
};

/** The most addresses a row keeps in `ip_addresses`; a CHECK holds it there too. */
export const MAX_COLLISION_IPS = 20;

export async function logEmailCollision(meeting: EmailCollisionMeeting): Promise<void> {
  const { source, email, userId, commenterId, postId, ipAddress } = meeting;
  const firstIps = ipAddress ? [ipAddress] : [];
  try {
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "email_collision"
        ("id", "source", "email", "user_id", "commenter_id", "post_id", "last_ip_address", "ip_addresses",
         "first_seen_at", "last_seen_at")
      VALUES (
        gen_random_uuid()::text, ${source}::"email_collision_source", ${email}, ${userId}, ${commenterId}, ${postId},
        ${ipAddress}, ${firstIps}::text[], now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC'
      )
      ON CONFLICT ("source", lower("email")) WHERE "reviewed_at" IS NULL DO UPDATE SET
        "count" = "email_collision"."count" + 1,
        "last_seen_at" = EXCLUDED."last_seen_at",
        "user_id" = EXCLUDED."user_id",
        "commenter_id" = EXCLUDED."commenter_id",
        "post_id" = EXCLUDED."post_id",
        "last_ip_address" = EXCLUDED."last_ip_address",
        "ip_addresses" = CASE
          WHEN EXCLUDED."last_ip_address" IS NULL
            OR EXCLUDED."last_ip_address" = ANY ("email_collision"."ip_addresses")
            OR cardinality("email_collision"."ip_addresses") >= ${MAX_COLLISION_IPS}
          THEN "email_collision"."ip_addresses"
          ELSE "email_collision"."ip_addresses" || EXCLUDED."last_ip_address"
        END
    `);
  } catch (err) {
    console.error("[email-collision] failed to log a meeting; the request goes ahead", { source, err });
  }
}
