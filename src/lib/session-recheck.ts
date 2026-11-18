// src/app/sign-in/NOTES.md, "The session reads its account again every five
// minutes" — when a session's token is due to be checked against its account.
// Pure, and apart from src/lib/auth.ts, so the arithmetic is tested without
// Auth.js or a database.

/** How long a token is trusted before the `jwt` callback reads its account again, when `SESSION_RECHECK_SECONDS` doesn't say. */
export const DEFAULT_SESSION_RECHECK_SECONDS = 300;

/**
 * `SESSION_RECHECK_SECONDS` as a number of seconds (docs/ENV.md). Anything
 * that isn't a positive whole number of seconds, unset included, is the
 * default: a typo must not turn the check off, nor make it run on every
 * request.
 */
export function sessionRecheckSeconds(raw: string | undefined): number {
  if (raw === undefined || !/^\s*\d+\s*$/.test(raw)) return DEFAULT_SESSION_RECHECK_SECONDS;
  const seconds = Number(raw);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : DEFAULT_SESSION_RECHECK_SECONDS;
}

/**
 * Whether a token last checked at `checkedAt` (epoch seconds) is due to be
 * checked again at `nowSeconds`:
 *
 * - a token with no `checkedAt`, or one that isn't a number, is due: it was
 *   issued before tokens carried the field, and has never been checked;
 * - a token checked `intervalSeconds` ago or longer is due;
 * - a token whose `checkedAt` is ahead of the clock is due, since a clock set
 *   back must not put the next check off by however far it moved.
 */
export function isSessionRecheckDue(checkedAt: unknown, nowSeconds: number, intervalSeconds: number): boolean {
  if (typeof checkedAt !== "number" || !Number.isFinite(checkedAt)) return true;
  if (checkedAt > nowSeconds) return true;
  return nowSeconds - checkedAt >= intervalSeconds;
}
