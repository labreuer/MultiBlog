import { SignJWT, jwtVerify } from "jose";
import type { Role } from "@/generated/prisma/enums";

// The collab server's credential (docs/YDOC.md, "The /admin endpoints"): a
// bearer token the Next process mints once it has authorized a user for one
// document, which server/ydoc-hooks.ts then trusts, on a websocket attach and
// on every /admin request. Two minutes is enough because each is spent at
// once: a connection is checked when it attaches, and a reconnect mints anew.
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
// So each names what it is for, and neither passes for the other.
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
