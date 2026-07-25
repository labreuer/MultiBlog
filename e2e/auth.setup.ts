// Runs once before every other project (see playwright.config.ts's `setup`
// project) and saves the shared admin's signed-in cookie jar to disk. Every
// later test starts already authenticated instead of paying for the sign-in
// form — which is the single biggest fixed cost in a suite like this.
import { test as setup, expect } from "@playwright/test";
import { ADMIN_STORAGE_STATE } from "../playwright.config";
import { ADMIN_EMAIL, TEST_PASSWORD, createTestPost, createTestUser, deleteTestPost, uniqueTitle } from "./db";

setup("create and sign in the shared admin", async ({ page }) => {
  // `trusted` so this account's own comments auto-approve — a moderation test
  // that wants a PENDING comment uses a fresh anonymous commenter instead.
  await createTestUser({ email: ADMIN_EMAIL, name: "E2E Admin", role: "ADMIN", trusted: true });

  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(ADMIN_EMAIL);
  await page.getByLabel("Password").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();

  await page.waitForURL("**/dashboard");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();

  await page.context().storageState({ path: ADMIN_STORAGE_STATE });

  // Warm `/posts/[id]/edit` before the workers start, and fail fast if live
  // editing is unavailable.
  //
  // It's much the heaviest route to compile (TipTap + Yjs + the collab
  // provider), and `next dev` compiles on first request — so without this,
  // every worker hits it cold simultaneously and the handshake can overrun
  // `waitForCollabReady`'s budget. Seen once for real: a full-suite run right
  // after a new editor spec was added timed out waiting for "🟢 Live", then
  // passed on the next run untouched.
  //
  // Doing it here also turns "the collab server isn't reachable" into a single
  // clear setup failure rather than a puzzling 30s timeout in every collab test.
  const warmup = await createTestPost({ authorEmail: ADMIN_EMAIL, title: uniqueTitle("warmup") });
  try {
    await page.goto(`/posts/${warmup.id}/edit`);
    await expect(page.getByText("🟢 Live")).toBeVisible({ timeout: 90_000 });
  } finally {
    await page.goto("about:blank").catch(() => {});
    await deleteTestPost(warmup.id);
  }
});
