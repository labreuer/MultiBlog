// End-to-end suite — see e2e/README.md for how it's laid out and what the
// fixtures give you. `dotenv/config` runs first because the DB helpers in
// e2e/db.ts import src/lib/prisma, which needs DATABASE_URL at import time.
import "dotenv/config";
import { defineConfig, devices } from "@playwright/test";

// Two targets (docs/playwright-flakiness.html):
//
// - **prod** (`npm run e2e`, via E2E_TARGET=prod): the full suite runs against
//   `next build` + `next start` on :3005 (scripts/e2e-web.ps1). Two of the
//   suite's historical failure classes are dev-only and compiled out of a
//   production build — the prerender-manifest RMW tear (vercel/next.js#96664,
//   ~1 tear per suite run, occasionally a 500 on an unrelated route) and
//   next-auth's dev-only SessionProvider invariant, which turns a transient
//   Turbopack SSR module miss into a 500. Next's own Playwright guide
//   recommends the prod target. Cookies don't scope by port, so the same
//   e2e/.auth/admin.json works on either target.
//
// - **dev** (`npm run e2e:dev`, or a bare `npx playwright test …`): the old
//   behavior, against `next dev` on :3000 — the fast loop for a spec or
//   feature under active development, with no build step. The
//   `devServer500Watch` fixture names the two dev-only 500 classes in a red
//   test's annotations so they don't read as app regressions.
const PROD = process.env.E2E_TARGET === "prod";

export const BASE_URL = PROD ? "http://localhost:3005" : "http://localhost:3000";
export const ADMIN_STORAGE_STATE = "e2e/.auth/admin.json";

export default defineConfig({
  testDir: "./e2e",
  // Files run in parallel across workers; tests inside one file stay in order.
  // Everything that touches the DB creates its own uniquely-named rows, so
  // cross-file interference is limited to the per-IP comment rate limit — see
  // the note in e2e/README.md before writing a test that posts via the form.
  fullyParallel: false,
  // Prod target: two. The 30-run matrix (docs/playwright-flakiness.html)
  // measured the dev server's request p50/p99 roughly doubling per added
  // worker (41/294 → 65/509 → 110/879 ms; requests ≥1s per run: ~1 → ~2 →
  // ~11), for the same ~200s wall clock — fixed costs dominate a 148-test
  // suite, so extra workers buy tail latency, not speed. `next start` is much
  // lighter per request, so 2 may be conservative there; remeasure before
  // raising it. Historical note: the "1 full run in 3.5 red at three workers"
  // measurement attributed to truncated server-action bodies was actually the
  // manifest tear above (same error string, Next parsing its own manifest).
  //
  // Dev target: one. The dev lane exists for iterating on a single spec or
  // feature, where parallelism buys nothing and the dev server's queueing
  // under 2+ workers is what used to make scattered, unreproducible failures
  // (and on a 2-core laptop, two workers reproduce what three did here).
  //
  // Override per machine with E2E_WORKERS in .env (loaded above, never
  // committed). `||` rather than `??`: a commented-out or blank `E2E_WORKERS=`
  // is an empty string, which `??` passes through and `Number("")` turns into
  // 0 — and Playwright rejects 0 outright. `||` folds empty, absent and
  // unparseable back to the default.
  workers: process.env.CI ? 1 : Number(process.env.E2E_WORKERS) || (PROD ? 2 : 1),
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
      port: Number(process.env.COLLAB_PORT ?? 1234),
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});
