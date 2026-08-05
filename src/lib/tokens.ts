import { randomBytes, createHash } from "crypto";

// Shared by every bearer-token flow that hands a raw value to the user and
// keeps only its hash at rest: password reset, and now invites
// (src/lib/invite.ts). Named generically since a third caller made the
// reset-specific names wrong.
export function generateToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("hex");
  return { raw, hash: hashToken(raw) };
}

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}
