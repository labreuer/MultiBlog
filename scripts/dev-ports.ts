// Single source of truth for this checkout's local port block and hostname, so
// a second working tree can run beside this one without either fighting for
// :3000.
//
// The machine runs two **slots** (docs/DEV_SLOTS.md). A slot
// is a working tree plus its own `.env`, its own Postgres database and its own
// `.file-storage`; what makes it a slot rather than a copy is exactly three
// values, all read from `.env`:
//
//   WEB_PORT     the dev server              slot A 3000   slot B 3005
//   COLLAB_PORT  Hocuspocus                  slot A 1234   slot B 1235
//   DEV_HOST     the hostname you browse at  slot A localhost   slot B b.localhost
//
// The other two web ports stay derived: WEB_PORT + 1 is the preview tool's
// `web-prod` (.claude/launch.json) and WEB_PORT + 2 is the e2e prod target
// (scripts/e2e-web.ps1). So a slot owns three consecutive web ports —
// {3000, 3001, 3002} and {3005, 3006, 3007} — and slots sit five apart, which
// leaves 3003/3004 as slack rather than packing them edge to edge. A third
// slot belongs at 3010.
//
// **Collab needs only one port per slot, and that is a fact about the app, not
// a simplification.** There is exactly one `new Server(...)` in the codebase
// (server/collab.ts); every documentName is `ydoc:`-prefixed and multiplexed
// over that single process, including the `ydoc:annotation:<id>` sub-namespace
// (CLAUDE.md, Gotchas). The e2e prod target does not start a second one either
// — playwright.config.ts's collab webServer uses `reuseExistingServer`, so the
// dev and prod web servers within a slot share the one Hocuspocus. Hence 1234
// and 1235 adjacent, with no block to reserve.
//
// **DEV_HOST is not about ports at all**, and it is the piece that is easy to
// think redundant. Cookies key on host and ignore port entirely — they predate
// the origin model — so two slots sharing one hostname share one
// `authjs.session-token` no matter how far apart their ports are: signing into
// one silently invalidates the other, and because the stale cookie is present
// rather than absent it surfaces as a JWT decrypt failure, which reads like an
// auth regression. Every *other* browser store (IndexedDB, localStorage,
// sessionStorage) is origin-scoped and therefore already separated by the port
// alone; cookies are the lone exception, which is why this one extra value
// exists.
//
// `*.localhost` rather than a hosts-file entry, having checked all three gates:
//   - it resolves to 127.0.0.1 with no hosts entry and no elevation — verified
//     through Node's own resolver, not just a browser, which is what Playwright's
//     webServer probe and any server-side fetch need;
//   - Next's dev cross-origin guard hardcodes '*.localhost' in its allowlist
//     (next/dist/server/lib/router-utils/block-cross-site-dev.js), so it needs
//     no `allowedDevOrigins` entry in next.config.ts and no restart;
//   - @auth/core defaults `trustHost` to true whenever NODE_ENV !== production
//     (lib/utils/env.js), so `next dev` needs no AUTH_URL/AUTH_TRUST_HOST. The
//     prod-mode servers still do, and already set them.
// An invented TLD (`multiblog-b.test`) fails the first two: it needs the hosts
// file *and* an allowedDevOrigins entry.
//
// scripts/dev-ports.ps1 is a hand-kept mirror of this file. PowerShell cannot
// import TS, and shelling out to `tsx` would put a cold node start in front of
// every `npm run e2e` via check-ports. Change one, change the other.
import "dotenv/config";

/**
 * `||` rather than `??`: a blank or commented-out `WEB_PORT=` is an empty
 * string, which `??` passes straight through and `Number("")` turns into 0 —
 * the same trap playwright.config.ts documents for E2E_WORKERS.
 */
function readPort(value: string | undefined, fallback: number): number {
  return Number(value) || fallback;
}

export const DEV_HOST = process.env.DEV_HOST || "localhost";
export const WEB_PORT = readPort(process.env.WEB_PORT, 3000);
export const WEB_PROD_PORT = WEB_PORT + 1;
export const E2E_WEB_PORT = WEB_PORT + 2;
export const COLLAB_PORT = readPort(process.env.COLLAB_PORT, 1234);

/** `http://<this slot's host>:<port>` — never hardcode `localhost` beside a slot port. */
export function webUrl(port: number): string {
  return `http://${DEV_HOST}:${port}`;
}
