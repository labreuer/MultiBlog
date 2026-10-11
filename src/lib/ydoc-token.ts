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
    .setIssuedAt()
    .setExpirationTime("2m")
    .sign(getSecret());
}

export async function verifyYdocToken(token: string): Promise<YdocTokenPayload> {
  const { payload } = await jwtVerify(token, getSecret());
  const { sub, documentName, role, readOnly } = payload as Record<string, unknown>;
  if (typeof sub !== "string" || typeof documentName !== "string" || typeof role !== "string") {
    throw new Error("Malformed ydoc token.");
  }
  return { sub, documentName, role: role as Role, readOnly: readOnly === true };
}
