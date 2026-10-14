import { SignJWT, jwtVerify } from "jose";
import { ACCESS_TOKEN_TTL_SECONDS } from "./discovery";

// docs/MCP.md §21, "A connection" — an OAuth connection's access token: good
// for an hour, signed as a byte grant is (jose, HS256, AUTH_SECRET), with the
// endpoint's URL as its audience and the connection's `api_token` id as its
// subject. Nothing else in it decides anything: the bearer check verifies
// it, then runs §3's one check on the row it names, so revoking the row, or
// deleting its account or its issuer, ends it on the next call however much
// of its hour is left.
//
// **Its audience keeps it apart** from the two tokens already signed with the
// same secret: a byte grant's is `multiblog:byte-grant` and a ydoc token's
// `multiblog:ydoc`, and each verifier names its own. So none of the three
// passes for another (access-token.test.ts).
//
// Rotating AUTH_SECRET ends every access token at once.
//
// No database here, so it is unit-tested; the check that follows it is
// `authenticateBearer` (src/lib/api/tokens.ts).

function getSecret(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set.");
  return new TextEncoder().encode(secret);
}

/** An access token for the connection `tokenId`, at `endpoint`. */
export async function signAccessToken(tokenId: string, endpoint: URL): Promise<{ accessToken: string; expiresIn: number }> {
  const accessToken = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(tokenId)
    .setAudience(endpoint.href)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(getSecret());
  return { accessToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
}

/**
 * The connection an access token names, the endpoint it was made for, and
 * its expiry in seconds — if it is live and its audience is one of
 * `endpoints`. Null otherwise.
 */
export async function verifyAccessToken(
  accessToken: string,
  endpoints: readonly URL[],
): Promise<{ tokenId: string; audience: URL; expiresAt: number } | null> {
  try {
    const { payload } = await jwtVerify(accessToken, getSecret(), {
      algorithms: ["HS256"],
      audience: endpoints.map((endpoint) => endpoint.href),
    });
    if (typeof payload.sub !== "string" || typeof payload.aud !== "string" || typeof payload.exp !== "number") return null;
    return { tokenId: payload.sub, audience: new URL(payload.aud), expiresAt: payload.exp };
  } catch {
    return null;
  }
}
