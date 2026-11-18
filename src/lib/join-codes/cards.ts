import bcrypt from "bcryptjs";
import { Prisma } from "@/generated/prisma/client";
import type { Role } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import type { Actor } from "@/lib/actor";
import { isAdmin } from "@/lib/role-checks";
import { forbidden, invalid } from "@/lib/api/errors";
import { generateToken, hashToken } from "@/lib/tokens";
import { sendMail } from "@/lib/mail";
import { appUrl } from "@/lib/app-url";
import { SITE_TITLE } from "@/lib/site-config";
import {
  AccountRefusal,
  anyAccountIdWithEmail,
  createPasswordAccount,
  isPlausibleEmail,
  liveAccountHasName,
  normalizeAccountEmail,
} from "@/lib/accounts";
import { logEmailCollision } from "@/lib/email-collision-log";
import { deriveJoinCode, hashJoinCode, joinCodeMatches, normalizeJoinCode } from "./code";
import { joinKey } from "./key";

// docs/EMAIL.md §10 — a one-off join card, from the scan to the account. The
// pure halves are code.ts (the code) and sheet.ts (the printed cards); this
// is everything that reads or writes a row. Server-only: plain functions,
// wrapped by the server actions in src/app/actions/join.ts and by
// scripts/join-codes/mint.ts.
//
// **Nothing here acts on a GET.** Looking a card or a claim up writes
// nothing, since QR readers, chat previews and mail scanners fetch a URL
// before anyone taps it; only a POST sends the mail or makes the account.

/** What every card makes: a constant, so no field in any form names a role. */
export const CARD_ROLE: Role = "AUTHOR";

/** Delivered sends a card has before it says to ask for another. */
export const MAX_CONFIRM_SENDS = 5;
/** The least time between two delivered sends for one card (docs/EMAIL.md §3's shape). */
export const RESEND_COOLDOWN_MS = 60 * 1000;
/** How long a confirmation link works after its mail was delivered. */
export const CONFIRM_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** The wrong passwords at Confirm that end a claim. */
export const MAX_CONFIRM_FAILURES = 5;
/** The most cards one batch holds. */
export const MAX_BATCH_CARDS = 500;
/** A card holder's name, trimmed, is 1 to this many characters. */
export const MAX_NAME_LENGTH = 100;
/** A password's least length, as on /sign-up. */
export const MIN_PASSWORD_LENGTH = 8;

// ─── Looking a card up ─────────────────────────────────────────────────────

/**
 * What `/join/<code>` shows for a code. `unusable` covers a revoked card, an
 * expired or revoked batch, a code that matches no row, and one that fails
 * re-derivation: its holder can do nothing different about any of them.
 */
export type JoinCardState =
  | { kind: "live"; card: { id: string; batchId: string; serial: number } }
  | { kind: "claimed" }
  | { kind: "sends-used" }
  | { kind: "unusable" };

const cardSelect = {
  id: true,
  batchId: true,
  serial: true,
  revokedAt: true,
  claimedAt: true,
  confirmSentAt: true,
  confirmSends: true,
  batch: { select: { revokedAt: true, expiresAt: true } },
} satisfies Prisma.JoinCodeSelect;

type CardRow = Prisma.JoinCodeGetPayload<{ select: typeof cardSelect }>;

/**
 * A code as typed or scanned, looked up by its hash and then **re-derived from
 * the row's batch and serial under the current key**, compared in constant
 * time. The hash survives a rotated AUTH_SECRET; the derivation doesn't, so a
 * card never outlives the key it was made with. Writes nothing.
 */
async function findCard(input: string): Promise<{ row: CardRow; code: string } | null> {
  const code = normalizeJoinCode(input);
  if (!code) return null;
  const row = await prisma.joinCode.findUnique({ where: { codeHash: hashJoinCode(code) }, select: cardSelect });
  if (!row || !joinCodeMatches(joinKey(), row.batchId, row.serial, code)) return null;
  return { row, code };
}

function stateOf(row: CardRow, now: Date): JoinCardState {
  if (row.claimedAt) return { kind: "claimed" };
  if (row.revokedAt || row.batch.revokedAt || row.batch.expiresAt <= now) return { kind: "unusable" };
  if (row.confirmSends >= MAX_CONFIRM_SENDS) return { kind: "sends-used" };
  return { kind: "live", card: { id: row.id, batchId: row.batchId, serial: row.serial } };
}

/** What `/join/<code>` shows; writes nothing. */
export async function lookupJoinCard(input: string): Promise<JoinCardState> {
  const found = await findCard(input);
  return found ? stateOf(found.row, new Date()) : { kind: "unusable" };
}

// ─── The claim ─────────────────────────────────────────────────────────────

export type ClaimInput = {
  code: string;
  name: string;
  email: string;
  password: string;
  ipAddress: string | null;
  /** Whether the request has a session: a card never changes an existing account, so a signed-in claim is refused. */
  signedIn: boolean;
};

export type ClaimResult =
  | { ok: true; email: string; delivered: boolean }
  | { ok: false; card: Exclude<JoinCardState["kind"], "live"> }
  | { ok: false; error: string };

export const SIGNED_IN_MESSAGE = "You're signed in. A card makes a new account, so sign out first to use it.";
export const EMAIL_TAKEN_MESSAGE =
  "An account with this email already exists, so this card can't make another. Sign in with it, or ask the organizer.";
export const NAME_TAKEN_MESSAGE = "An account already goes by this name. Add something that tells you apart.";

/**
 * The scan's POST (docs/EMAIL.md §10, "The card holder's path", step 3):
 * checks the card again from scratch, refuses an email any account has and a
 * name a live account goes by, refuses a send within a minute of the last,
 * writes the pending claim with a fresh confirmation token (keeping only its
 * hash), and sends the mail.
 *
 * **The send is reserved before it is made.** The write that puts the claim
 * on the card also stamps `confirm_sent_at` and counts the send, on condition
 * that neither has moved since the card was read, so two submits at once
 * can't both pass the minute's rule or the five-send cap. A failed send is
 * then taken back, on condition that the claim is still this one: the claim
 * stays, the send is neither counted nor stamped, and the retry isn't refused
 * by the minute's rule.
 */
export async function claimJoinCode(input: ClaimInput): Promise<ClaimResult> {
  if (input.signedIn) return { ok: false, error: SIGNED_IN_MESSAGE };

  const found = await findCard(input.code);
  const now = new Date();
  if (!found) return { ok: false, card: "unusable" };
  const state = stateOf(found.row, now);
  if (state.kind !== "live") return { ok: false, card: state.kind };
  const card = found.row;

  const name = input.name.trim();
  const email = normalizeAccountEmail(input.email);
  if (!name) return { ok: false, error: "Your name is required: it goes on everything you write here." };
  if (name.length > MAX_NAME_LENGTH) return { ok: false, error: `A name is at most ${MAX_NAME_LENGTH} characters.` };
  if (!isPlausibleEmail(email)) return { ok: false, error: "That doesn't look like an email address." };
  if (input.password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }

  if (await liveAccountHasName(name)) return { ok: false, error: NAME_TAKEN_MESSAGE };
  const existingId = await anyAccountIdWithEmail(email);
  if (existingId) {
    await logEmailCollision({
      source: "CARD_CLAIM",
      email,
      userId: existingId,
      commenterId: null,
      postId: null,
      ipAddress: input.ipAddress,
      joinCodeId: card.id,
    });
    return { ok: false, error: EMAIL_TAKEN_MESSAGE };
  }

  if (card.confirmSentAt && now.getTime() - card.confirmSentAt.getTime() < RESEND_COOLDOWN_MS) {
    return { ok: false, error: "A confirmation mail went out for this card a moment ago. Wait a minute, then try again." };
  }

  const passwordHash = await bcrypt.hash(input.password, 12);
  const { raw, hash } = generateToken();
  const reserved = await prisma.joinCode.updateMany({
    where: {
      id: card.id,
      claimedAt: null,
      revokedAt: null,
      confirmSentAt: card.confirmSentAt,
      confirmSends: card.confirmSends,
      batch: { revokedAt: null, expiresAt: { gt: now } },
    },
    data: {
      pendingEmail: email,
      pendingName: name,
      pendingPasswordHash: passwordHash,
      pendingIpAddress: input.ipAddress,
      confirmTokenHash: hash,
      confirmFailures: 0,
      confirmSentAt: now,
      confirmSends: card.confirmSends + 1,
    },
  });
  if (reserved.count === 0) {
    return { ok: false, error: "This card was used from somewhere else just now. Try again in a minute." };
  }

  const link = appUrl(`/join/confirm?token=${raw}`);
  const sent = await sendMail({
    to: email,
    subject: `Confirm your email for ${SITE_TITLE}`,
    text:
      `Someone, hopefully you, used a ${SITE_TITLE} card to make an account with this email.\n\n` +
      `To make it, open this link and enter the password you chose:\n\n${link}\n\n` +
      `The link works for seven days. If you ignore this mail, no account is made.`,
  });

  if (!sent.delivered) {
    await prisma.joinCode.updateMany({
      where: { id: card.id, confirmTokenHash: hash },
      data: { confirmSentAt: card.confirmSentAt, confirmSends: card.confirmSends },
    });
  }
  return { ok: true, email, delivered: sent.delivered };
}

// ─── The confirmation ──────────────────────────────────────────────────────

/** The `where` of a claim that can still be confirmed, at `now`. */
function liveClaimWhere(tokenHash: string, now: Date): Prisma.JoinCodeWhereInput {
  return {
    confirmTokenHash: tokenHash,
    claimedAt: null,
    revokedAt: null,
    confirmSentAt: { gt: new Date(now.getTime() - CONFIRM_TTL_MS) },
    batch: { revokedAt: null, expiresAt: { gt: now } },
  };
}

/**
 * Whether a card's stored hash is still the one its batch and serial derive
 * under the current key: a pending claim made before AUTH_SECRET was rotated
 * can't be confirmed after, as its card can't be claimed.
 */
function derivesUnderCurrentKey(row: { batchId: string; serial: number; codeHash: string }): boolean {
  return hashJoinCode(deriveJoinCode(joinKey(), row.batchId, row.serial)) === row.codeHash;
}

/** The email `/join/confirm` shows for a token, or null for a claim that can't be confirmed. Writes nothing. */
export async function lookupJoinClaim(token: string): Promise<{ email: string } | null> {
  if (!token) return null;
  const row = await prisma.joinCode.findFirst({
    where: liveClaimWhere(hashToken(token), new Date()),
    select: { pendingEmail: true, batchId: true, serial: true, codeHash: true },
  });
  if (!row?.pendingEmail || !derivesUnderCurrentKey(row)) return null;
  return { email: row.pendingEmail };
}

export type ConfirmInput = { token: string; password: string; ipAddress: string | null };

export type ConfirmResult =
  | { ok: true; email: string }
  | { ok: false; kind: "no-claim" }
  | { ok: false; kind: "wrong-password"; left: number }
  | { ok: false; kind: "claim-ended" }
  | { ok: false; kind: "refused"; error: string };

/**
 * The confirmation's POST (step 6). The password chosen at the scan is
 * checked first, against the pending hash: whoever typed the email knows it,
 * and a stranger who only received the mail doesn't. A wrong one is counted
 * by a write of its own, and the fifth ends the claim. Then one transaction
 * takes the card, makes the account and its trusted commenter row, and
 * records who claimed the card. After it commits, an anonymous identity with
 * the email is logged as a `CARD_CONFIRM` meeting, and never adopted.
 */
export async function confirmJoinClaim(input: ConfirmInput): Promise<ConfirmResult> {
  if (!input.token) return { ok: false, kind: "no-claim" };
  const tokenHash = hashToken(input.token);
  const claim = await prisma.joinCode.findFirst({
    where: liveClaimWhere(tokenHash, new Date()),
    select: { id: true, pendingPasswordHash: true, batchId: true, serial: true, codeHash: true },
  });
  if (!claim?.pendingPasswordHash || !derivesUnderCurrentKey(claim)) return { ok: false, kind: "no-claim" };

  if (!(await bcrypt.compare(input.password, claim.pendingPasswordHash))) {
    // One statement, so two wrong passwords at once both count. Every SET
    // reads the row as it was, so the fifth failure nulls the claim whole,
    // as the CHECK on its four columns asks.
    const rows = await prisma.$queryRaw<{ failures: number; ended: boolean }[]>(Prisma.sql`
      UPDATE "join_code" SET
        "confirm_failures" = "confirm_failures" + 1,
        "pending_email" = CASE WHEN "confirm_failures" + 1 >= ${MAX_CONFIRM_FAILURES} THEN NULL ELSE "pending_email" END,
        "pending_name" = CASE WHEN "confirm_failures" + 1 >= ${MAX_CONFIRM_FAILURES} THEN NULL ELSE "pending_name" END,
        "pending_password_hash" = CASE WHEN "confirm_failures" + 1 >= ${MAX_CONFIRM_FAILURES} THEN NULL ELSE "pending_password_hash" END,
        "pending_ip_address" = CASE WHEN "confirm_failures" + 1 >= ${MAX_CONFIRM_FAILURES} THEN NULL ELSE "pending_ip_address" END,
        "confirm_token_hash" = CASE WHEN "confirm_failures" + 1 >= ${MAX_CONFIRM_FAILURES} THEN NULL ELSE "confirm_token_hash" END
      WHERE "id" = ${claim.id} AND "confirm_token_hash" = ${tokenHash}
      RETURNING "confirm_failures" AS failures, ("confirm_token_hash" IS NULL) AS ended
    `);
    const row = rows[0];
    if (!row) return { ok: false, kind: "no-claim" };
    if (row.ended) return { ok: false, kind: "claim-ended" };
    return { ok: false, kind: "wrong-password", left: MAX_CONFIRM_FAILURES - row.failures };
  }

  let made: { userId: string; email: string; joinCodeId: string; claimIp: string | null; anonymousId: string | null };
  try {
    made = await prisma.$transaction(async (tx) => {
      const now = new Date();
      // Read inside the transaction, and taken below on condition that the
      // token is still this one, so what was read is what is claimed.
      const pending = await tx.joinCode.findFirst({
        where: liveClaimWhere(tokenHash, now),
        select: { id: true, pendingEmail: true, pendingName: true, pendingPasswordHash: true, pendingIpAddress: true },
      });
      if (!pending?.pendingEmail || !pending.pendingName || !pending.pendingPasswordHash) throw new NoClaim();

      // Takes the card: a count of 0 is the refusal, and what a second click
      // meets. The pending claim is nulled in the same statement, as the
      // CHECK on a claimed card asks.
      const taken = await tx.joinCode.updateMany({
        where: { id: pending.id, ...liveClaimWhere(tokenHash, now) },
        data: {
          claimedAt: now,
          pendingEmail: null,
          pendingName: null,
          pendingPasswordHash: null,
          pendingIpAddress: null,
          confirmTokenHash: null,
        },
      });
      if (taken.count === 0) throw new NoClaim();

      const user = await createPasswordAccount(tx, {
        email: pending.pendingEmail,
        name: pending.pendingName,
        passwordHash: pending.pendingPasswordHash,
        role: CARD_ROLE,
        emailVerified: now,
        refuseTakenName: true,
      });
      await tx.commenter.create({
        data: { userId: user.id, email: user.email, displayName: pending.pendingName, trusted: true },
      });
      await tx.joinCode.update({ where: { id: pending.id }, data: { claimedUserId: user.id } });

      const anonymous = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT id FROM "commenter" WHERE user_id IS NULL AND lower(email) = lower(${user.email}) ORDER BY id LIMIT 1
      `);
      return {
        userId: user.id,
        email: user.email,
        joinCodeId: pending.id,
        claimIp: pending.pendingIpAddress,
        anonymousId: anonymous[0]?.id ?? null,
      };
    });
  } catch (err) {
    if (err instanceof NoClaim) return { ok: false, kind: "no-claim" };
    if (err instanceof AccountRefusal) {
      return {
        ok: false,
        kind: "refused",
        error:
          err.reason === "email-taken"
            ? "An account with this email was made after the card was scanned, so this card can't make another. Sign in with it, or ask the organizer."
            : "An account has taken this name since the card was scanned. Scan the card again and choose a name that tells you apart.",
      };
    }
    throw err;
  }

  if (made.anonymousId) {
    await logEmailCollision({
      source: "CARD_CONFIRM",
      email: made.email,
      userId: made.userId,
      commenterId: made.anonymousId,
      postId: null,
      ipAddress: input.ipAddress,
      joinCodeId: made.joinCodeId,
      claimIpAddress: made.claimIp,
    });
  }
  return { ok: true, email: made.email };
}

class NoClaim extends Error {}

// ─── Minting, printing and revoking ────────────────────────────────────────

function requireAdmin(actor: Actor): void {
  if (!isAdmin(actor.role)) throw forbidden("Only an ADMIN mints, prints or revokes join cards.");
}

export type MintInput = { label: string; count: number; expiresAt: Date };

/**
 * A batch of `count` cards, serials 1 to `count`, in one transaction. Each
 * row keeps its code's hash; the codes are returned for printing, and are
 * derived again from the rows whenever they are needed.
 */
export async function mintJoinBatch(
  actor: Actor,
  input: MintInput,
): Promise<{ batchId: string; cards: { serial: number; code: string }[] }> {
  requireAdmin(actor);
  const label = input.label.trim();
  if (!label || label.length > 200) throw invalid("A batch needs a label of 1 to 200 characters.");
  if (!Number.isInteger(input.count) || input.count < 1 || input.count > MAX_BATCH_CARDS) {
    throw invalid(`A batch holds 1 to ${MAX_BATCH_CARDS} cards.`);
  }
  if (!(input.expiresAt instanceof Date) || Number.isNaN(input.expiresAt.getTime()) || input.expiresAt <= new Date()) {
    throw invalid("A batch's expiry must be in the future.");
  }
  const key = joinKey();
  return prisma.$transaction(async (tx) => {
    const batch = await tx.joinBatch.create({
      data: { label, expiresAt: input.expiresAt, createdById: actor.userId },
      select: { id: true },
    });
    const cards = Array.from({ length: input.count }, (_, i) => ({
      serial: i + 1,
      code: deriveJoinCode(key, batch.id, i + 1),
    }));
    await tx.joinCode.createMany({
      data: cards.map((card) => ({ batchId: batch.id, serial: card.serial, codeHash: hashJoinCode(card.code) })),
    });
    return { batchId: batch.id, cards };
  });
}

/**
 * A batch's cards that can still be claimed, with their codes, for printing.
 * Refuses a batch any of whose stored hashes the current key doesn't derive,
 * rather than print cards that match no row.
 */
export async function liveCardsForPrinting(
  actor: Actor,
  batchId: string,
): Promise<{ label: string; cards: { serial: number; code: string }[] }> {
  requireAdmin(actor);
  const batch = await prisma.joinBatch.findUnique({
    where: { id: batchId },
    select: { label: true, revokedAt: true, expiresAt: true, codes: { select: { serial: true, codeHash: true, revokedAt: true, claimedAt: true }, orderBy: { serial: "asc" } } },
  });
  if (!batch) throw invalid("No such batch.");
  if (batch.revokedAt) throw invalid("That batch is revoked.");
  if (batch.expiresAt <= new Date()) throw invalid("That batch has expired.");
  const key = joinKey();
  const cards = batch.codes.map((row) => ({ ...row, code: deriveJoinCode(key, batchId, row.serial) }));
  if (cards.some((card) => hashJoinCode(card.code) !== card.codeHash)) {
    throw invalid("This batch was minted under another AUTH_SECRET, so its cards can't be printed again.");
  }
  return {
    label: batch.label,
    cards: cards.filter((card) => !card.revokedAt && !card.claimedAt).map(({ serial, code }) => ({ serial, code })),
  };
}

/** A pending claim nulled whole, as the CHECK on its four columns asks. */
const NO_CLAIM = {
  pendingEmail: null,
  pendingName: null,
  pendingPasswordHash: null,
  pendingIpAddress: null,
  confirmTokenHash: null,
} as const;

/**
 * Revokes one card, or with no serial the batch, and nulls every pending
 * claim it ends, so no password hash is left behind. A claimed card is left
 * as it is: its account is managed on /users. Returns how many unclaimed
 * cards it ended.
 */
export async function revokeJoinCards(actor: Actor, batchId: string, serial?: number): Promise<number> {
  requireAdmin(actor);
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const batch = await tx.joinBatch.findUnique({ where: { id: batchId }, select: { id: true } });
    if (!batch) throw invalid("No such batch.");
    if (serial === undefined) {
      await tx.joinBatch.updateMany({ where: { id: batchId, revokedAt: null }, data: { revokedAt: now } });
      const ended = await tx.joinCode.updateMany({ where: { batchId, claimedAt: null }, data: { ...NO_CLAIM } });
      return ended.count;
    }
    const card = await tx.joinCode.findUnique({ where: { batchId_serial: { batchId, serial } }, select: { id: true } });
    if (!card) throw invalid(`The batch has no card ${serial}.`);
    const ended = await tx.joinCode.updateMany({
      where: { id: card.id, claimedAt: null, revokedAt: null },
      data: { revokedAt: now, ...NO_CLAIM },
    });
    return ended.count;
  });
}
