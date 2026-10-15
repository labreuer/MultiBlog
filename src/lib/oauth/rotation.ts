// docs/MCP.md §21, "A connection" — what happens to a presented refresh
// token. It is rotated on every use, as the spec requires for a public
// client, and **a rotated token presented again revokes the connection**:
// either the client or a thief holds a copy, and the row can't tell which
// (OAuth 2.1 §4.3.1).
//
// **The exception is a retry.** While none of the tokens issued from it has
// been used, and for at most two minutes, a rotated token is answered again
// with a new pair: a client that lost the answer, or sent two refreshes at
// once, is not a thief. This departs on purpose from OAuth 2.1, under which
// a rotated token is simply invalid.
// - An access token's use never closes the window, since every call in
//   flight can get a 401 when an hour runs out, and a second refresh a few
//   seconds after the first would otherwise revoke a healthy connection.
// - Using a token issued from it closes the window at once: the old token
//   presented after that is a copy.
// - Using either of two tokens issued from one retires the other, and a
//   retired token counts as a replay. Whoever lost the split presents theirs
//   sooner or later, and that is how the split is found.
//
// Pure, so the rule is unit-tested (rotation.test.ts); the token endpoint
// reads the state under a lock on the connection's row
// (src/lib/oauth/refresh.ts, grant.ts).

/** How long a rotated token is still answered, as a retry. */
export const RETRY_WINDOW_MS = 2 * 60_000;

/** What decides a presented refresh token's fate, beyond its expiry. */
export type RefreshState = {
  /** When it was rotated, or null if it never has been. */
  usedAt: Date | null;
  /** Whether a token issued from it has been used in turn. */
  childUsed: boolean;
  /** Whether another token issued from its parent has been used. */
  siblingUsed: boolean;
};

/**
 * - `rotate`: a fresh token, spent now for a new pair;
 * - `retry`: rotated two minutes ago or less with none of its children spent,
 *   so answered again with another pair;
 * - `replay`: past the window, a child spent, or retired by a sibling's use,
 *   so the connection is revoked.
 */
export type Rotation = "rotate" | "retry" | "replay";

export function rotationVerdict(state: RefreshState, now: number): Rotation {
  if (state.siblingUsed) return "replay";
  if (state.usedAt === null) return "rotate";
  if (state.childUsed || now - state.usedAt.getTime() > RETRY_WINDOW_MS) return "replay";
  return "retry";
}

/**
 * Whether a connection has lapsed, given its newest refresh token, if any: a
 * connection lapses when that one passes its 90 days (§21, "Seeing and ending
 * a connection"). One with none was made by the thin slice, whose migration
 * revoked them all, so it counts as lapsed too.
 */
export function hasLapsed(newest: readonly { expiresAt: Date }[], now: Date): boolean {
  return newest.length === 0 || newest[0].expiresAt <= now;
}
