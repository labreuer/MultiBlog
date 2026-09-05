// A production `next start` for this slot, in one of two roles:
//
//   npm run e2e:web    `tsx scripts/prod-web.ts e2e`
//                      `next build`, then `next start` on WEB_PORT + 2 — the
//                      e2e suite's prod target (:3002 in slot A, so it
//                      coexists with `dev:all` on :3000 and the preview tool's
//                      web-prod on :3001). Launched by playwright.config.ts's
//                      webServer when E2E_TARGET=prod and nothing is already
//                      listening there; with reuseExistingServer a server left
//                      running skips the rebuild on later runs.
//
//   npm run web-prod   `tsx scripts/prod-web.ts preview`
//                      `next start` on WEB_PORT + 1 against whatever
//                      `npm run build` last produced — the preview tool's
//                      web-prod entry (.claude/launch.json), for anything
//                      caching-related, since `next dev` enforces neither the
//                      static/dynamic split nor the Full Route Cache
//                      (CACHING.md). No build: that is deliberate, so a
//                      restart doesn't rebuild underneath the e2e server that
//                      shares the same .next.
//
// Both roles set three things:
//
//   AUTH_TRUST_HOST / AUTH_URL   NextAuth under `next start` rejects localhost
//                                as an UntrustedHost without them — `next dev`
//                                trusts every host, prod mode trusts none
//                                (CACHING.md's 2026-07-24 entry). AUTH_URL must
//                                name the same hostname playwright.config.ts's
//                                BASE_URL uses, or the suite signs in against
//                                one cookie host and navigates on another —
//                                which is why the host comes from dev-ports.ts
//                                rather than being spelled `localhost` here.
//   APP_URL                      The invite flow builds absolute URLs from it;
//                                .env's copy names the dev server, which this
//                                server is not — without the override
//                                invite.spec navigates to a port nothing is
//                                listening on.
//
// and the e2e role additionally sets E2E_REVALIDATE=1, which enables
// /api/test/revalidate (see that route's header): fixtures write the DB
// directly, so on an ISR'd page only an explicit revalidation makes the write
// visible within the revalidate window.
//
// `npm run build` rather than next's bin directly, so `prebuild`
// (scripts/copy-pdfjs-assets.ts) still runs — the one spawn here that goes
// through npm, and so the one that needs a shell on Windows. `next start` *is*
// spawned on the bin by absolute path (scripts/resolve-from-root.ts), for the
// same reason dev-web.ts does — every process in the tree then carries this
// repo's path in its command line, which is what scripts/dev-servers.ts's
// ownership test reads.
import { spawn, spawnSync } from "node:child_process";
import { E2E_WEB_PORT, WEB_PROD_PORT, webUrl } from "./dev-ports";
import { resolveFromRoot } from "./resolve-from-root";

const role = process.argv[2];
if (role !== "e2e" && role !== "preview") {
  console.error("usage: tsx scripts/prod-web.ts <e2e|preview>");
  process.exit(2);
}

const port = role === "e2e" ? E2E_WEB_PORT : WEB_PROD_PORT;
const baseUrl = webUrl(port);
const env: NodeJS.ProcessEnv = {
  ...process.env,
  AUTH_TRUST_HOST: "true",
  AUTH_URL: baseUrl,
  APP_URL: baseUrl,
  ...(role === "e2e" ? { E2E_REVALIDATE: "1" } : {}),
};

if (role === "e2e") {
  console.log(`[prod-web] building for the e2e target on ${baseUrl}`);
  // `shell` on Windows only: npm is npm.cmd there, and a .cmd needs a shell.
  const build = spawnSync("npm", ["run", "build"], { stdio: "inherit", env, shell: process.platform === "win32" });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const nextBin = resolveFromRoot("next/dist/bin/next");

console.log(`[prod-web] ${role}: starting next start on ${baseUrl}`);
const child = spawn(process.execPath, [nextBin, "start", "-p", String(port)], { stdio: "inherit", env });

// Playwright stops the webServer it started by killing the process tree, and
// the preview tool sends a signal to this process; either way, take the server
// down with us rather than leaving a `next start` orphaned on the port.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => {
    child.kill(sig);
  });
}
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
