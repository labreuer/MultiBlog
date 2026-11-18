import { deriveJoinKey } from "./code";

// The join-code key under this instance's AUTH_SECRET (docs/EMAIL.md §10,
// "The code"). Read on each call rather than once at import, so a script
// that loads .env after importing this still gets it; derived once per secret.
// Rotating AUTH_SECRET voids every unclaimed card, as it already ends every
// session and access token.

let cached: { secret: string; key: Buffer } | null = null;

export function joinKey(): Buffer {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set, so no join code can be made or checked.");
  if (cached?.secret !== secret) cached = { secret, key: deriveJoinKey(secret) };
  return cached.key;
}
