import { headers } from "next/headers";
import { clientIpFromHeaders } from "@/lib/client-ip";

// The IP address nginx saw, for a comment's `ip_address`, the comment rate
// limits and the email-collision log (docs/COMMENTS.md, "Identities kept
// apart"). The header rule is clientIpFromHeaders's (src/lib/client-ip.ts),
// a pure function so its table is unit-tested.
export async function getClientIp(): Promise<string | null> {
  const h = await headers();
  return clientIpFromHeaders((name) => h.get(name));
}
