import {
  bearerAuthChallengeResponse,
  getOAuthProtectedResourceMetadataUrl,
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
// Two kinds of bearer reach the check: a header token's `mb_` secret, and an
// OAuth connection's access token. The check that tells them apart is passed
// in (`authenticateBearer`, src/lib/api/tokens.ts, in the route), so
// everything here is pure and unit-tested (bearer.test.ts).
//
// **The scopes go to the challenge alone.** Given to the verification as
// `requiredScopes`, `read write` would refuse a read-only token with a 403;
// the tool list is what narrows a token by scope (§3). So the gate is the
// two calls rather than `requireBearerAuth`, which passes one set of options
// to both.

/** The scopes /api/mcp names in its 401 (§21, Discovery). */
export const MCP_SCOPES = ["read", "write"];

/**
 * What a bearer value authenticates as: §3's token, the endpoint it is good
 * for, and its expiry in seconds — a header token's row's, or an access
 * token's own.
 */
export type Bearer = { token: AuthenticatedToken; resource: URL; expiresAt: number | undefined };

/** §3's one check, from a bearer value sent to `endpoint`; null when it refuses. */
export type Authenticate = (value: string, endpoint: URL) => Promise<Bearer | null>;

/**
 * What a bearer reports to v2: its scopes as OAuth names them, its expiry,
 * the endpoint it is for, its client — a connection's client_id, or a header
 * token's prefix — and the token itself in `extra`, where the MCP handler's
 * factory reads it.
 */
export function authInfoFor(bearer: Bearer, value: string): AuthInfo {
  return {
    token: value,
    clientId: bearer.token.oauthClientId ?? bearer.token.prefix,
    scopes: bearer.token.scopes.map((scope) => scope.toLowerCase()),
    ...(bearer.expiresAt !== undefined ? { expiresAt: bearer.expiresAt } : {}),
    resource: bearer.resource,
    extra: { token: bearer.token },
  };
}

/** v2's verifier over §3's one check. A refusal is `invalid_token`, which v2 answers with the 401. */
export function tokenVerifier(endpoint: URL, authenticate: Authenticate): OAuthTokenVerifier {
  return {
    async verifyAccessToken(value) {
      const bearer = await authenticate(value, endpoint);
      if (!bearer) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, "The token is unknown, revoked or expired, or its account is gone.");
      }
      return authInfoFor(bearer, value);
    },
  };
}

/**
 * The gate: the verified token's `AuthInfo`, or the response that refuses
 * the request. `endpoint` is the endpoint's URL, so v2 refuses a token
 * reported for any other, and the 401 names its metadata document.
 */
export async function bearerGate(request: Request, endpoint: URL, authenticate: Authenticate): Promise<AuthInfo | Response> {
  // As requireBearerAuth reads it: the first of several Authorization headers.
  const [header] = (request.headers.get("authorization") ?? "").split(",");
  try {
    return await verifyBearerToken(header || undefined, {
      verifier: tokenVerifier(endpoint, authenticate),
      expectedResource: endpoint,
    });
  } catch (err) {
    // Anything but a refusal is the check failing, answered 500 by v2 and
    // logged here, since v2 keeps nothing of it.
    if (!(err instanceof OAuthError)) console.error("[mcp] the bearer check failed:", err);
    return bearerAuthChallengeResponse(err, {
      requiredScopes: MCP_SCOPES,
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(endpoint),
    });
  }
}
