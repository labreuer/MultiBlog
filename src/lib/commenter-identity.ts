import { Prisma } from "@/generated/prisma/client";
import type { Commenter } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";

// Which commenter row a comment is posted under (docs/COMMENTS.md,
// "Identities kept apart"). **An anonymous identity is found by its email,
// among anonymous identities only; a signed-in one by its user alone.** The
// email is unique only `WHERE user_id IS NULL` (the partial index
// `commenter_anonymous_email_key`), so no `upsert` can be keyed on it: both
// paths find, then create, and find again when a concurrent first comment won
// the insert.
//
// Server-only: plain functions, not "use server".

const isUniqueViolation = (err: unknown) => (err as { code?: unknown } | null)?.code === "P2002";

/**
 * The live account whose email this is, in any case. Raw SQL on purpose:
 * Prisma's `mode: "insensitive"` compiles to an unescaped `ILIKE`, where `_`
 * and `%` are wildcards, so `a_b@example.com` would match `axb@example.com`;
 * and a raw query skips prisma.ts's soft-delete extension, so the
 * `deleted_by_user_id IS NULL` is written here rather than assumed.
 */
export async function liveAccountIdWithEmail(email: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT id FROM "user"
    WHERE lower(email) = lower(${email}) AND deleted_by_user_id IS NULL
    ORDER BY created_at, id
    LIMIT 1
  `);
  return rows[0]?.id ?? null;
}

/**
 * The anonymous identity holding this email, in any case. The signed-out path
 * stores an email lowercased, but an account's may be stored in any case, so
 * the comparison lowercases both sides; raw for the `ILIKE` reason above.
 */
export async function anonymousCommenterIdWithEmail(email: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT id FROM "commenter"
    WHERE user_id IS NULL AND lower(email) = lower(${email})
    ORDER BY id
    LIMIT 1
  `);
  return rows[0]?.id ?? null;
}

/**
 * The anonymous identity for a signed-out comment. `email` is the form's,
 * already trimmed and lowercased, which is how every anonymous row holds it,
 * so the lookup is the partial index's own exact match.
 */
export async function findOrCreateAnonymousCommenter(email: string, displayName: string): Promise<Commenter> {
  const find = () => prisma.commenter.findFirst({ where: { email, userId: null } });
  const found = await find();
  if (found) return found;
  try {
    return await prisma.commenter.create({ data: { email, displayName } });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const winner = await find();
    if (!winner) throw err;
    return winner;
  }
}

/**
 * A signed-in commenter's row, found by their user alone. `created` says
 * whether this call made it, which is when an anonymous identity holding the
 * same email is logged (`SIGNED_IN_COMMENT`), once per account rather than
 * on every comment after.
 */
export async function findOrCreateSignedInCommenter(
  userId: string,
  email: string,
  displayName: string,
): Promise<{ commenter: Commenter; created: boolean }> {
  const found = await prisma.commenter.findUnique({ where: { userId } });
  if (found) return { commenter: found, created: false };
  try {
    return { commenter: await prisma.commenter.create({ data: { userId, email, displayName } }), created: true };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const winner = await prisma.commenter.findUnique({ where: { userId } });
    if (!winner) throw err;
    return { commenter: winner, created: false };
  }
}
