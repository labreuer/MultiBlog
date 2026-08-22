// End-to-end suite — see e2e/README.md for how it's laid out and what the
// fixtures give you. `dotenv/config` runs first because the DB helpers in
// e2e/db.ts import src/lib/prisma, which needs DATABASE_URL at import time.
import "dotenv/config";
import { defineConfig, devices } from "@playwright/test";

export const BASE_URL = "http://localhost:3000";
export const ADMIN_STORAGE_STATE = "e2e/.auth/admin.json";

export default defineConfig({
  testDir: "./e2e",
  // Files run in parallel across workers; tests inside one file stay in order.
  // Everything that touches the DB creates its own uniquely-named rows, so
  // cross-file interference is limited to the per-IP comment rate limit — see
  // the note in e2e/README.md before writing a test that posts via the form.
  fullyParallel: false,
  // Two, not three. Three workers overload the *dev server*, not the machine:
  // measured symptoms were a public page 500ing with next-auth's
  // "useSession must be wrapped in a <SessionProvider />" during SSR, and
  // server actions arriving with truncated bodies ("Unexpected end of JSON
  // input" on /posts/[id]/edit), neither reproducible in isolation and neither
  // an app defect. Failure rate was roughly 1 full run in 3.5 at three
  // workers, 0 in 8 at two — for the same ~50s wall clock, because the dev
  // server is the bottleneck rather than the parallelism.
  workers: process.env.CI ? 1 : 2,
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
    {
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
