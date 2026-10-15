import { hasLapsed } from "@/lib/oauth/rotation";

// docs/MCP.md §21, "Seeing and ending a connection" — whether a token's row
// still works, as /dashboard's Connections card and `create-api-token.ts
// --list` show it. Pure, so the card and the script read one rule.
//
// **A connection lapses rather than expires.** Its row has no `expires_at`,
// since each access token carries its own hour, and the lapse writes
// nothing: it is dated by the connection's newest refresh token, which the
// pruner keeps for this (src/lib/oauth/refresh.ts). A header token expires at
// its `expires_at`, which a CHECK requires it to have.

export type TokenStateRow = {
  oauthClientId: string | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  /** A connection's newest refresh token, if any: `NEWEST_REFRESH_TOKEN`'s selection. */
  refreshTokens: readonly { expiresAt: Date }[];
};

export type TokenState =
  | { kind: "live" }
  | { kind: "revoked"; at: Date }
  /** `at` is null only for a connection with no refresh token at all, which the thin slice's migration revoked. */
  | { kind: "lapsed"; at: Date | null }
  | { kind: "expired"; at: Date };

export function tokenState(row: TokenStateRow, now: Date): TokenState {
  if (row.revokedAt !== null) return { kind: "revoked", at: row.revokedAt };
  if (row.oauthClientId !== null) {
    return hasLapsed(row.refreshTokens, now) ? { kind: "lapsed", at: row.refreshTokens[0]?.expiresAt ?? null } : { kind: "live" };
  }
  if (row.expiresAt !== null && row.expiresAt <= now) return { kind: "expired", at: row.expiresAt };
  return { kind: "live" };
}
