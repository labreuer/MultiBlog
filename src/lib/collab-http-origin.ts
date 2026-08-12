// The origin the **Next server process** uses to reach the Hocuspocus
// server's plain-HTTP admin endpoints (`/admin/ydoc-snapshot`,
// `/admin/annotation-mark`, `/admin/annotation-unmark`,
// `/admin/annotation-flush`). Server-to-server only — nothing client-side
// ever calls these; the browser's websocket URL is `collab-url.ts`'s
// `getCollabUrl()`, which is a different thing entirely and must stay that
// way.
//
// **Deliberately NOT derived from NEXT_PUBLIC_COLLAB_URL**, which is what
// `annotation-admin.ts` and `ydoc-admin.ts` both used to do
// (`wsUrl.replace(/^ws/, "http")`). That worked in dev, where the var is
// unset and the fallback is already `ws://localhost:1234`, and broke every
// one of these endpoints in production, silently:
//
//   DEPLOY.md §4 sets NEXT_PUBLIC_COLLAB_URL="wss://<app-host>/collab" so the
//   browser reaches the collab websocket through nginx on one host and one
//   cert. Rewriting the scheme gives "https://<app-host>/collab", so the POST
//   goes to `https://<app-host>/collab/admin/annotation-flush`. DEPLOY.md §7's
//   `location /collab { proxy_pass http://127.0.0.1:1234; }` has no URI part,
//   so nginx forwards the request URI **unmodified** — the collab process sees
//   `/collab/admin/annotation-flush`, and server/collab.ts's onRequest matches
//   with `request.url?.startsWith("/admin/annotation-flush")`, which is false.
//   The request falls through to Hocuspocus's default "Welcome to Hocuspocus!"
//   200, so the caller sees a perfectly successful response that did nothing.
//
// The websocket was never affected (Hocuspocus upgrades on any path), which is
// why live editing worked in production while every one of these endpoints was
// a no-op — see PLAN.md §13m.
//
// Going straight to the loopback address instead fixes it at the root and is
// what a server-to-server call wanted anyway: no TLS handshake, no proxy hop,
// no path prefix to keep in sync with nginx, and the /admin/* endpoints need
// never be reachable from outside the box at all (they're token-guarded, but
// unreachable beats guarded).
//
// COLLAB_INTERNAL_URL is the escape hatch for the one case the default can't
// serve — a collab server on a *different* host from the web app. Bare, not
// NEXT_PUBLIC_, since it's read server-side only: changing it needs a restart,
// not a rebuild.
export function collabHttpOrigin(): string {
  const url = process.env.COLLAB_INTERNAL_URL ?? `http://127.0.0.1:${process.env.COLLAB_PORT ?? 1234}`;
  return url.replace(/\/$/, "");
}
