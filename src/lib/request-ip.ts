import { headers } from "next/headers";

// Behind nginx (see PLAN.md §7), the real client IP arrives via
// X-Forwarded-For; direct-to-Node access would use X-Real-IP. Neither is
// authenticated, so this is best-effort — fine for moderation context, not
// a security boundary.
export async function getClientIp(): Promise<string | null> {
  const h = await headers();
  const forwardedFor = h.get("x-forwarded-for");
  if (forwardedFor) {
    return forwardedFor.split(",")[0].trim();
  }
  return h.get("x-real-ip");
}
