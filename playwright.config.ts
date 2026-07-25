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
  workers: process.env.CI ? 1 : 3,
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
    },
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
