import {
  bearerAuthChallengeResponse,
  OAuthError,
  OAuthErrorCode,
  verifyBearerToken,
  type AuthInfo,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import type { AuthenticatedToken } from "@/lib/api/tokens";

// docs/MCP.md §21, "The bearer check, on v2's terms" — how /api/mcp knows who
// is calling: SDK v2's `verifyBearerToken`, with §3's one check as its
// verifier, and v2's `bearerAuthChallengeResponse` for a refusal. The byte
// routes keep their own check (src/lib/api/request-auth.ts), since they take
// a grant as well as the token.
//
// The check itself is passed in (`authenticateSecret`, in the route), so
// everything here is pure and unit-tested (bearer.test.ts).
//
// **The scopes go to the challenge alone.** Given to the verification as
// `requiredScopes`, `read write` would refuse a read-only token with a 403;
// the tool list is what narrows a token by scope (§3). So the gate is the
// two calls rather than `requireBearerAuth`, which passes one set of options
// to both.

/** The scopes /api/mcp names in its 401 (§21, Discovery). */
export const MCP_SCOPES = ["read", "write"];

/** §3's one check: the token a secret names, or null. */
export type Authenticate = (secret: string) => Promise<AuthenticatedToken | null>;

/**
 * What a header token reports to v2: its scopes as OAuth names them, its
 * expiry in seconds, the endpoint it was sent to as its resource, its prefix
 * as its client, and the token itself in `extra`, where the MCP handler's
 * factory reads it.
 */
export function authInfoFor(token: AuthenticatedToken, secret: string, resource: URL): AuthInfo {
  return {
    token: secret,
    clientId: token.prefix,
    scopes: token.scopes.map((scope) => scope.toLowerCase()),
    ...(token.expiresAt ? { expiresAt: Math.floor(token.expiresAt.getTime() / 1000) } : {}),
    resource,
    extra: { token },
  };
}

/** v2's verifier over §3's one check. A refusal is `invalid_token`, which v2 answers with the 401. */
export function tokenVerifier(resource: URL, authenticate: Authenticate): OAuthTokenVerifier {
  return {
    async verifyAccessToken(secret) {
      const token = await authenticate(secret);
      if (!token) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, "The token is unknown, revoked or expired, or its account is gone.");
      }
      return authInfoFor(token, secret, resource);
    },
  };
}

/**
 * The gate: the verified token's `AuthInfo`, or the response that refuses
 * the request. `resource` is the endpoint's URL, so v2 refuses a token
 * reported for any other.
 */
export async function bearerGate(request: Request, resource: URL, authenticate: Authenticate): Promise<AuthInfo | Response> {
  // As requireBearerAuth reads it: the first of several Authorization headers.
  const [header] = (request.headers.get("authorization") ?? "").split(",");
  try {
    return await verifyBearerToken(header || undefined, {
      verifier: tokenVerifier(resource, authenticate),
      expectedResource: resource,
    });
  } catch (err) {
    // Anything but a refusal is the check failing, answered 500 by v2 and
    // logged here, since v2 keeps nothing of it.
    if (!(err instanceof OAuthError)) console.error("[mcp] the bearer check failed:", err);
    return bearerAuthChallengeResponse(err, { requiredScopes: MCP_SCOPES });
  }
}
