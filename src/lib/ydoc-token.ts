import { SignJWT, jwtVerify } from "jose";
import type { Role } from "@/generated/prisma/enums";

// Parallel to collab-token.ts, deliberately not a shared/generic token: the
// two stacks are kept fully independent (PLAN.md §11) so a change to one
// payload shape can never accidentally affect the other's verification. Same
// secret and expiry as collab-token.ts purely because both are short-lived
// bearer tokens minted by an already-authorized Next server action/route and
// consumed once by the collab server's onAuthenticate — there's no shared
// behavior worth factoring out, just a coincidentally identical policy.
function getSecret(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error("AUTH_SECRET is not set.");
  }
  return new TextEncoder().encode(secret);
}

// docs/MCP.md §5 — the audience every ydoc token carries and every verifier
// checks. The MCP byte grants (src/lib/api/grants.ts) are signed with the same
// secret and the same algorithm, so without an audience on each a grant shown
// to the collab server would be stopped only by lacking a `documentName`.
// Each now names what it is for, and neither passes for the other.
export const YDOC_TOKEN_AUDIENCE = "multiblog:ydoc";

export type YdocTokenPayload = {
  sub: string;
  documentName: string;
  role: Role;
  // PLAN.md §12g — set for a doc reader who satisfies canViewDocs on a
  // SHARED doc but isn't an editor. Absent (not merely false) for every
  // /ydoc-debug token, so ydocOnAuthenticate's default stays writable there.
  readOnly?: boolean;
};

export async function signYdocToken(payload: YdocTokenPayload): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setAudience(YDOC_TOKEN_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("2m")
    .sign(getSecret());
}

export async function verifyYdocToken(token: string): Promise<YdocTokenPayload> {
  const { payload } = await jwtVerify(token, getSecret(), { audience: YDOC_TOKEN_AUDIENCE });
  const { sub, documentName, role, readOnly } = payload as Record<string, unknown>;
  if (typeof sub !== "string" || typeof documentName !== "string" || typeof role !== "string") {
    throw new Error("Malformed ydoc token.");
  }
  return { sub, documentName, role: role as Role, readOnly: readOnly === true };
}
