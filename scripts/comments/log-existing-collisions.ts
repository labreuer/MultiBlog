// Logs, as `EXISTING` rows of the email-collision log, every anonymous
// commenter whose email a live account has, in any case (docs/COMMENTS.md,
// "The log"), so meetings from before identities were kept apart are in the
// same place an ADMIN reviews the new ones: /email-collisions. Run once per
// instance at deploy, after `prisma migrate deploy`.
//
// Usage:
//   npx tsx scripts/comments/log-existing-collisions.ts            # write
//   npx tsx scripts/comments/log-existing-collisions.ts --dry-run  # list only
//
// **It inserts only where no `EXISTING` row has the email, reviewed or not.**
// The fold's index (`email_collision_unreviewed_key`) covers unreviewed rows
// alone, so folding would re-insert every pair an ADMIN has already reviewed.
// So it is safe to run again: a second run adds what is new and counts
// nothing. Each row names the account and the anonymous identity; it has no
// post and no request IP addresses, since no request made it, and the page
// reads each side's comment IP addresses live.
//
// The comparison is raw `lower(email) = lower(email)` among accounts with no
// `deleted_by_user_id`, never Prisma's `mode: "insensitive"`, whose `ILIKE`
// reads `_` and `%` as wildcards (src/lib/commenter-identity.ts).

import "dotenv/config";
import { Prisma } from "../../src/generated/prisma/client";
import { prisma } from "../../src/lib/prisma";

type Pair = { email: string; commenter_id: string; user_id: string; user_email: string };

async function main() {
  const known = new Set(["--dry-run"]);
  const unknown = process.argv.slice(2).filter((arg) => !known.has(arg));
  if (unknown.length > 0) throw new Error(`Unknown argument(s): ${unknown.join(" ")}. Usage: [--dry-run]`);
  const dryRun = process.argv.includes("--dry-run");

  // One pair per lowercased email: the fold's key, and the existence check's.
  // The earliest account wins where two live accounts differ only in case.
  const pairs = await prisma.$queryRaw<Pair[]>(Prisma.sql`
    SELECT DISTINCT ON (lower(c.email))
      c.email, c.id AS commenter_id, u.id AS user_id, u.email AS user_email
    FROM "commenter" c
    JOIN "user" u ON lower(u.email) = lower(c.email) AND u.deleted_by_user_id IS NULL
    WHERE c.user_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM "email_collision" ec
        WHERE ec.source = 'EXISTING' AND lower(ec.email) = lower(c.email)
      )
    ORDER BY lower(c.email), u.created_at, u.id, c.id
  `);

  if (pairs.length === 0) {
    console.log("No new meetings: every anonymous identity sharing a live account's email is logged already.");
    return;
  }
  for (const pair of pairs) {
    console.log(`${dryRun ? "Would log" : "Logging"}: ${pair.email} — anonymous ${pair.commenter_id}, account ${pair.user_id} (${pair.user_email})`);
  }
  if (dryRun) return;

  let inserted = 0;
  for (const pair of pairs) {
    // ON CONFLICT DO NOTHING: an unreviewed EXISTING row can't be there (the
    // query above excluded any), but a concurrent run could have made one.
    inserted += await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "email_collision"
        ("id", "source", "email", "user_id", "commenter_id", "first_seen_at", "last_seen_at")
      VALUES (
        gen_random_uuid()::text, 'EXISTING', ${pair.email}, ${pair.user_id}, ${pair.commenter_id},
        now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC'
      )
      ON CONFLICT ("source", lower("email")) WHERE "reviewed_at" IS NULL DO NOTHING
    `);
  }
  console.log(`Logged ${inserted} of ${pairs.length}. Review them at /email-collisions.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
