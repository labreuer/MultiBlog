// End-to-end suite — see e2e/README.md for how it's laid out and what the
// fixtures give you. `dotenv/config` runs first because the DB helpers in
// e2e/db.ts import src/lib/prisma, which needs DATABASE_URL at import time.
import "dotenv/config";
import os from "node:os";
import { defineConfig, devices } from "@playwright/test";
// The slot's hostname and port block. Ports are no longer literals here
// because a second working tree runs beside this one on its own block —
// see scripts/dev-ports.ts for what a slot is and why DEV_HOST matters as
// much as the numbers do.
import { COLLAB_PORT, E2E_WEB_PORT, WEB_PORT, webUrl } from "./scripts/dev-ports";

// Two targets (docs/playwright-flakiness.html):
//
// - **prod** (`npm run e2e`, via E2E_TARGET=prod): the full suite runs against
//   `next build` + `next start` on WEB_PORT + 2 — :3002 in slot A
//   (scripts/e2e-web.ps1). Two of the suite's historical failure classes are
//   dev-only and compiled out of a production build — the prerender-manifest
//   RMW tear (vercel/next.js#96664, ~1 tear per suite run, occasionally a 500
//   on an unrelated route) and next-auth's dev-only SessionProvider invariant,
//   which turns a transient Turbopack SSR module miss into a 500. Next's own
//   Playwright guide recommends the prod target. Cookies don't scope by port,
//   so the same e2e/.auth/admin.json works on either target — which holds only
//   because both targets share this slot's DEV_HOST. That same port-blindness
//   is why two slots need different *hostnames* and not merely different
//   ports (scripts/dev-ports.ts).
//
// - **dev** (`npm run e2e:dev`, or a bare `npx playwright test …`): the old
//   behavior, against `next dev` on WEB_PORT — :3000 in slot A. The fast loop
//   for a spec or feature under active development, with no build step. The
//   `devServer500Watch` fixture names the two dev-only 500 classes in a red
//   test's annotations so they don't read as app regressions.
const PROD = process.env.E2E_TARGET === "prod";

/**
 * The worker count measured to be right, on 12 logical cores. Measured twice:
 * the 30-run dev matrix (2026-08-22/23) and a 6-run prod matrix (2026-08-24)
 * that exists because the first one's conclusion did not transfer. Raise only
 * with a fresh matrix behind it; see the block on `workers` below.
 */
const MEASURED_WORKERS = 2;

/** Never above what was measured; below it when the machine is visibly smaller. */
const PROD_WORKERS = Math.max(1, Math.min(MEASURED_WORKERS, Math.floor(os.cpus().length / 4)));

export const BASE_URL = PROD ? webUrl(E2E_WEB_PORT) : webUrl(WEB_PORT);
export const ADMIN_STORAGE_STATE = "e2e/.auth/admin.json";

export default defineConfig({
  testDir: "./e2e",
  // Files run in parallel across workers; tests inside one file stay in order.
  // Everything that touches the DB creates its own uniquely-named rows, so
  // cross-file interference is limited to the per-IP comment rate limit — see
  // the note in e2e/README.md before writing a test that posts via the form.
  fullyParallel: false,
  // **The prod default is derived, not a constant, so no machine has to be
  // described in prose.** The 30-run matrix (docs/playwright-flakiness.html)
  // measured this on one box and the number that came out of it was 2; what
  // used to sit here instead was advice telling the reader to translate "a
  // weaker machine" into a smaller number themselves, with no way to check the
  // translation. MEASURED_WORKERS is that measurement, and the clamp below is
  // what carries it to hardware the matrix never ran on.
  //
  // What the matrix actually found: the dev server's request p50/p99 roughly
  // doubles per added worker (41/294 → 65/509 → 110/879 ms; requests ≥1s per
  // run: ~1 → ~2 → ~11) for the same ~200s wall clock — fixed costs dominate a
  // 148-test suite, so extra workers buy tail latency, not speed, and it is the
  // tail that trips 10s expect budgets.
  //
  // **Prod was then measured separately, because that reasoning does not carry
  // over** — and it half didn't. 2 rounds × {2,3,4} workers against
  // `next start`, interleaved, servers warm (docs/playwright-flakiness.html
  // records it):
  //
  //   2 workers   117 / 121 s   0 red / 2 runs   p50 1.0 s   p95 3.8 s   none ≥ 10 s
  //   3 workers    98 / 108 s   1 red / 2 runs   p50 1.2 s   p95 4.3 s
  //   4 workers    95 / 101 s   1 red / 2 runs   p50 1.5 s   p95 5.0 s
  //
  // So unlike dev, prod *does* get faster — 3 workers is ~13% quicker and 4 is
  // ~18%. The suspicion that 2 was conservative here was right about the speed
  // and wrong about the price: the tail grows with it (p50 +30-55%, p95
  // +20-40%), and above 2 workers a run's slowest test starts crossing the 10 s
  // expect budget. Both reds were contention, not logic — a `toBeVisible`
  // timeout on /files, and a title-history row read mid-Yjs-sync (`"ydoc"` where
  // `"ydoc title <n>"` was expected) — scattered across unrelated specs and not
  // repeating, which is the documented signature. **Trading ~16 s a run for a
  // spurious red that reads exactly like a real regression is the same bad trade
  // `retries: 0` below already refuses.** Two rounds is thin evidence on its
  // own; what makes it credible is that the reds move monotonically with the
  // latency tail rather than appearing on their own.
  //
  // **What saturates is the browsers, not the server**, which is worth knowing
  // before reading the table above as "next start strains at 4 clients". A
  // pure-HTTP sweep of the same warm server (no Chromium) answers /search — the
  // dynamic, DB-hitting route — with a p99 of 52 ms at concurrency 4 and 68 ms
  // at 16, against test durations of 1.0-1.4 s: the server is single-digit
  // percent of a test. The contention is four Chromium instances against this
  // box's 12 threads, alongside the server, Postgres and collab. Zero non-2xx
  // in six runs. That is also the argument for keying the clamp below on
  // os.cpus().length: the ceiling is a property of the host's cores, not of the
  // application, so a bigger box legitimately supports more.
  //
  // Historical note: the "1 full run in 3.5 red at three workers" measurement
  // attributed to truncated server-action bodies was actually the manifest tear
  // above (same error string, Next parsing its own manifest).
  //
  // The divisor is deliberately coarse and the clamp deliberately one-sided.
  // Worker counts have been measured, but only ever on one *machine*, so the
  // honest shape is "never exceed what was measured, and back off below it when
  // there is visibly less machine": 12 logical cores → 2 (the measured box),
  // 8 → 2, 4 → 1, 2 → 1. It errs toward 1 because the failure mode of too many
  // workers is scattered red across unrelated specs that reads exactly like a
  // real regression — far more expensive than a slower run. Note this is well
  // under Playwright's own default of half the cores, which would be 6 here.
  //
  // Dev target: one, and *not* derived. The dev lane exists for iterating on a
  // single spec, where parallelism buys nothing, and its ceiling is the dev
  // server serializing SSR rather than anything about the CPU — so there is no
  // core count at which raising it would be right.
  //
  // E2E_WORKERS in .env overrides both (never committed, so it stays per
  // machine). `||` rather than `??`: a commented-out or blank `E2E_WORKERS=`
  // is an empty string, which `??` passes through and `Number("")` turns into
  // 0 — and Playwright rejects 0 outright. `||` folds empty, absent and
  // unparseable back to the default.
  workers: process.env.CI ? 1 : Number(process.env.E2E_WORKERS) || (PROD ? PROD_WORKERS : 1),
  forbidOnly: !!process.env.CI,
  // No local retries on purpose: a retry that turns a red run green hides
  // exactly the collab/WS timing regressions this suite exists to catch.
  retries: process.env.CI ? 2 : 0,
  // Generous because `next dev` compiles a route on first request, and
  // /posts/[id]/edit pulls in TipTap + Yjs.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/, teardown: "cleanup" },
    { name: "cleanup", testMatch: /cleanup\.teardown\.ts/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], storageState: ADMIN_STORAGE_STATE },
      dependencies: ["setup"],
      testIgnore: /dark-mode\.spec\.ts/,
    },
    // Scoped to one spec via testMatch, not the whole suite — duplicating
    // every test under a second color scheme would roughly double wall clock
    // for near-zero incremental coverage, since nothing else in the suite
    // asserts on color (STYLE.md's Dark theme section).
    {
      name: "chromium-dark",
      testMatch: /dark-mode\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], storageState: ADMIN_STORAGE_STATE, colorScheme: "dark" },
      dependencies: ["setup"],
    },
    // Gecko, for the engine differences chromium can't surface — chiefly
    // contenteditable selection and beforeinput behavior, which is where
    // ProseMirror diverges most. Playwright drives its own Firefox build
    // (v1538 / Firefox 153.0), not /Applications/Firefox.app: there is no
    // stable-channel option for Firefox the way there is for Chrome.
    //
    // Gated behind E2E_FIREFOX rather than added to the projects list
    // unconditionally, because a project in that list runs on every bare
    // `playwright test` — which would roughly double the wall clock of the
    // everyday `npm run e2e` for a suite whose day-to-day job is catching
    // regressions in our own logic, not Gecko's. Same reasoning as
    // chromium-dark's testMatch above. Run it with:
    //
    //   E2E_FIREFOX=1 npx playwright test --project=firefox
    //
    // The flag alone is not enough — without the env var the project does
    // not exist and Playwright errors with "Project(s) 'firefox' not found".
    ...(process.env.E2E_FIREFOX
      ? [
          {
            name: "firefox",
            use: { ...devices["Desktop Firefox"], storageState: ADMIN_STORAGE_STATE },
            dependencies: ["setup"],
            testIgnore: /dark-mode\.spec\.ts/,
          },
        ]
      : []),
    // WebKit, for the one class of bug no amount of chromium coverage can
    // reach: the PDF surface runs pdfjs, and pdfjs uses modern built-ins that
    // WebKit ships late or not at all. Two have already bitten an iPad —
    // Map.prototype.getOrInsertComputed and ReadableStream's async iterator,
    // both now patched in src/lib/pdfjs-webkit-polyfills.ts. Each was invisible
    // locally, because a chromium-only suite runs the one engine that has them.
    //
    // This is *not* iPadOS Safari — Playwright drives its own WebKit build, so
    // the native selection gestures an iPad uses (long-press, the drag handles)
    // are still unreproducible here. What it does share is the JS engine, which
    // is where those two bugs live.
    //
    // **It does not run on macOS 14 at all**, and the failure is not yours to
    // fix: playwright 1.62 targets webkit 2336, but browsers.json pins mac14
    // (and mac14-arm64) to a frozen 2251 build via revisionOverrides, whose
    // protocol has no `PushAPIEnabled` setting — so every test dies in
    // `browserContext.newPage` with `Protocol error (Page.overrideSetting)`
    // before its body runs. `playwright install --force webkit` re-downloads
    // the same pinned build and changes nothing. It unblocks on macOS 15+, or
    // on Linux CI. That is why the polyfills' own coverage lives in
    // e2e/pdf-webkit-gaps.spec.ts, which simulates each gap in chromium and so
    // runs everywhere — this project is a bonus, not the guard.
    //
    // Gated behind E2E_WEBKIT for the same reason as firefox above: a project
    // in this list runs on every bare `playwright test`. Run it with:
    //
    //   E2E_WEBKIT=1 npx playwright test --project=webkit
    //
    ...(process.env.E2E_WEBKIT
      ? [
          {
            name: "webkit",
            use: { ...devices["Desktop Safari"], storageState: ADMIN_STORAGE_STATE },
            dependencies: ["setup"],
            testIgnore: /dark-mode\.spec\.ts/,
          },
        ]
      : []),
  ],
  // `reuseExistingServer` is unconditional rather than `!process.env.CI`: the
  // user frequently has `npm run dev:all` up already, and CLAUDE.md is explicit
  // that a dev server we didn't start is not ours to kill. If nothing is
  // listening, Playwright starts both halves itself and stops them at the end.
  webServer: [
    PROD
      ? {
          // Build + serve the production bundle (scripts/e2e-web.ps1). The
          // timeout covers a full `next build` on a cold :3005; a server left
          // running from a previous run skips it entirely via
          // reuseExistingServer.
          command: "npm run e2e:web",
          url: BASE_URL,
          reuseExistingServer: true,
          timeout: 300_000,
        }
      : {
          command: "npm run dev",
          url: BASE_URL,
          reuseExistingServer: true,
          timeout: 180_000,
        },
    {
      // A raw WebSocket server, so wait on the TCP port — an HTTP probe of the
      // Hocuspocus endpoint proves nothing useful.
      command: "npm run collab",
      port: COLLAB_PORT,
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});
