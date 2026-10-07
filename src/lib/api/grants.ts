import { SignJWT, jwtVerify } from "jose";

// docs/MCP.md §5 — a byte grant: a URL-borne stand-in for the bearer token on
// one route, for ten minutes, so nothing Claude runs in a shell needs the
// token itself. `upload_url` and `download_url` mint them; the byte routes
// accept one in place of the token.
//
// Signed as the collab server's ydoc token is (jose, HS256, AUTH_SECRET;
// src/lib/ydoc-token.ts), with an audience of its own — and that one has an
// audience too, checked wherever it is verified, so neither passes for the
// other. It carries the token's id, the route and the expiry, and nothing
// else: a route accepting one runs §3's whole check on the token it names, so
// revoking the token, or deleting its user, ends its grants at once.
//
// A grant in a URL lands in access logs. It opens one route for ten minutes,
// where a token in a URL would open everything until revoked, which is the
// difference that makes one acceptable and the other not.

export const BYTE_GRANT_AUDIENCE = "multiblog:byte-grant";

/** How long a grant stands in for its token. */
export const BYTE_GRANT_TTL_SECONDS = 10 * 60;

/** The query parameter a byte route reads a grant from. */
export const GRANT_PARAM = "grant";

function getSecret(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set.");
  return new TextEncoder().encode(secret);
}

/** `route` is the path the grant opens, exactly: `/api/mcp/files/<id>`, `/api/mcp/export`. */
export async function signByteGrant(tokenId: string, route: string): Promise<{ grant: string; expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + BYTE_GRANT_TTL_SECONDS * 1000);
  const grant = await new SignJWT({ route })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(tokenId)
    .setAudience(BYTE_GRANT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(getSecret());
  return { grant, expiresAt };
}

/** The token id a grant names, if it is a live grant for exactly `route`; null otherwise. */
export async function verifyByteGrant(grant: string, route: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(grant, getSecret(), { audience: BYTE_GRANT_AUDIENCE });
    if (typeof payload.sub !== "string" || payload.route !== route) return null;
    return payload.sub;
  } catch {
    return null;
  }
}
