import { GRANT_PARAM, verifyByteGrant } from "./grants";
import { authenticateSecret, authenticateTokenId, bearerSecret, type AuthenticatedToken } from "./tokens";

// docs/MCP.md §5 — how a byte route knows who is calling: the bearer token,
// from a program that holds one (a local script refreshing an export), or a
// grant minted from it by `upload_url` or `download_url`, from a shell that
// holds nothing. Either way §3's one check runs on the token, so a grant
// stops working the moment its token or its user does.
//
// Never the session cookie: nothing under /api/mcp answers a browser.

/** The token behind a request to `route`, or null. `route` is the exact path the grant must name. */
export async function authenticateByteRequest(request: Request, route: string): Promise<AuthenticatedToken | null> {
  const secret = bearerSecret(request);
  if (secret) return authenticateSecret(secret);
  const grant = new URL(request.url).searchParams.get(GRANT_PARAM);
  if (!grant) return null;
  const tokenId = await verifyByteGrant(grant, route);
  return tokenId ? authenticateTokenId(tokenId) : null;
}

/** What a byte route answers when nothing authenticated it. */
export function unauthorizedResponse(): Response {
  return new Response(JSON.stringify({ code: "unauthorized", message: "A bearer token or a live grant is required." }), {
    status: 401,
    headers: { "Content-Type": "application/json", "WWW-Authenticate": 'Bearer realm="multiblog"' },
  });
}
