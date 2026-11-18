// Which header holds the client's IP address, behind nginx (DEPLOY.md §7).
//
// **`X-Real-IP` first**: nginx sets it to the peer it accepted the connection
// from (`proxy_set_header X-Real-IP $remote_addr`), replacing anything the
// client sent. **Failing that, the *last* `X-Forwarded-For` entry**, never the
// first: nginx's `$proxy_add_x_forwarded_for` appends the peer to whatever the
// client sent, so every entry before the last is the client's own claim. Next
// writes `X-Forwarded-For` from the socket only when it is absent, so with no
// proxy at all (development, the e2e suite) the one entry is the socket's.
//
// This trusts the headers only because nginx is the only way in: the web unit
// binds `next start` to 127.0.0.1 (`-H 127.0.0.1`), so no request reaches it
// directly to write `X-Real-IP` itself. A CDN in front of nginx would make
// every client the CDN's address. DEPLOY.md states both assumptions.
export function clientIpFromHeaders(get: (name: string) => string | null): string | null {
  const realIp = get("x-real-ip")?.trim();
  if (realIp) return realIp;
  const forwardedFor = get("x-forwarded-for");
  if (forwardedFor) {
    const entries = forwardedFor
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (entries.length > 0) return entries[entries.length - 1];
  }
  return null;
}
