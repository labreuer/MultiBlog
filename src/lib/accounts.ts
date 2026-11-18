import { Prisma } from "@/generated/prisma/client";
import type { Role } from "@/generated/prisma/enums";
import { prisma, type TransactionClient } from "@/lib/prisma";
import { colorForSeed } from "@/lib/author-colors";
import { uniqueUserSlug } from "@/lib/user-slug";
import { deriveInitials } from "@/lib/user-initials";
import { isUniqueViolationOn } from "@/lib/unique-violation";
import { normalizeAccountEmail } from "@/lib/account-email";

export { isPlausibleEmail, normalizeAccountEmail } from "@/lib/account-email";

// Making an account with a password, and finding one by an email a person
// typed (docs/EMAIL.md §10, "Mistakes that fail no check"). `/sign-up` and a
// join card's confirmation both make their account through
// createPasswordAccount; sign-in and password reset find theirs through
// liveAccountIdWithEmail.
//
// **An email is stored trimmed, as typed, and compared without its case**, so
// an account signs in and resets its password with its email typed in any
// case. Lowercasing it when stored would change what the account shows and
// mails to, for nothing the comparison doesn't already give. Every
// comparison that ignores case is raw SQL, `lower(email) = lower($1)`:
// Prisma's `mode: "insensitive"` compiles to an unescaped `ILIKE`, where `_`
// and `%` are wildcards, so `first_last@x.com` would match
// `firstXlast@x.com`. Raw SQL also skips prisma.ts's soft-delete extension,
// so a lookup of live accounts says `deleted_by_user_id IS NULL` itself. The
// unique index `user_email_lower_key` makes each lookup find at most one
// account, and is what holds against two requests racing for one email.
//
// Server-only: plain functions, not "use server".

type RawClient = Pick<TransactionClient, "$queryRaw">;

/** The live account with this email in any case, or null. Sign-in and password reset find theirs here. */
export async function liveAccountIdWithEmail(email: string, db: RawClient = prisma): Promise<string | null> {
  const rows = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT id FROM "user"
    WHERE lower(email) = lower(${normalizeAccountEmail(email)}) AND deleted_by_user_id IS NULL
    LIMIT 1
  `);
  return rows[0]?.id ?? null;
}

/** The account, deleted or not, with this email in any case, or null: the one a new account's email would collide with. */
export async function anyAccountIdWithEmail(email: string, db: RawClient = prisma): Promise<string | null> {
  const rows = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT id FROM "user" WHERE lower(email) = lower(${normalizeAccountEmail(email)}) LIMIT 1
  `);
  return rows[0]?.id ?? null;
}

/** Whether a live account goes by this name, compared without case. */
export async function liveAccountHasName(name: string, db: RawClient = prisma): Promise<boolean> {
  const rows = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT id FROM "user"
    WHERE lower(name) = lower(${name.trim()}) AND deleted_by_user_id IS NULL
    LIMIT 1
  `);
  return rows.length > 0;
}

/** Why createPasswordAccount made no account. */
export type AccountRefusalReason = "email-taken" | "name-taken";

/**
 * Thrown by createPasswordAccount when it refuses, so that a transaction it
 * runs in rolls back whatever came before it; the caller catches it and
 * answers with `message`.
 */
export class AccountRefusal extends Error {
  constructor(readonly reason: AccountRefusalReason) {
    super(
      reason === "email-taken"
        ? "An account with that email already exists."
        : "An account already goes by this name. Add something that tells you apart.",
    );
    this.name = "AccountRefusal";
  }
}

const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

export type NewPasswordAccount = {
  /** As typed; stored trimmed. */
  email: string;
  /** Trimmed here; empty means none. */
  name: string | null;
  passwordHash: string;
  /** COMMENTER when left out, the column's default. */
  role?: Role;
  /** When the email was proven, which only a join card's confirmation does. */
  emailVerified?: Date;
  /** Refuse a name a live account goes by, compared without case: a join card asks, `/sign-up` doesn't. */
  refuseTakenName?: boolean;
};

/**
 * Makes an account with a password, on `tx`, a transaction's client. Refuses,
 * by throwing AccountRefusal, an email any account has in any case, deleted
 * or not, and, when asked, a name a live account goes by. The email check is
 * made here, inside the caller's transaction, and the `lower(email)` index
 * backs it against a concurrent request: its violation is the same refusal.
 * A slug, a color and initials are made as `/sign-up` always made them.
 *
 * Takes named fields and builds the row from them (CLAUDE.md,
 * check:prisma-data).
 */
export async function createPasswordAccount(
  tx: TransactionClient,
  input: NewPasswordAccount,
): Promise<{ id: string; email: string; name: string | null; slug: string }> {
  const email = normalizeAccountEmail(input.email);
  const name = input.name?.trim() || null;
  if (await anyAccountIdWithEmail(email, tx)) throw new AccountRefusal("email-taken");
  if (input.refuseTakenName && name && (await liveAccountHasName(name, tx))) throw new AccountRefusal("name-taken");

  const slug = await uniqueUserSlug(name, email);
  try {
    return await tx.user.create({
      data: {
        email,
        slug,
        name,
        passwordHash: input.passwordHash,
        role: input.role,
        emailVerified: input.emailVerified,
        color: colorForSeed(email),
        adminInitials: deriveInitials(name, email),
      },
      select: { id: true, email: true, name: true, slug: true },
    });
  } catch (err) {
    // The email's two indexes are the only unique ones a racing request can
    // take first besides the slug's, and a slug race is rare enough to report
    // as the 500 it is. The `lower(email)` index's violation names no column
    // Prisma can parse (`lower(email`), so it is told apart by not being the
    // slug's.
    if (isUniqueViolation(err) && !isUniqueViolationOn(err, "slug")) {
      throw new AccountRefusal("email-taken");
    }
    throw err;
  }
}

/** createPasswordAccount in a transaction of its own: `/sign-up`'s case. */
export async function createPasswordAccountAlone(input: NewPasswordAccount) {
  return prisma.$transaction((tx) => createPasswordAccount(tx, input));
}
