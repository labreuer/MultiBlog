// /dashboard re-reads the signed-in user from the database and re-issues the
// session cookie on every visit (src/components/SessionRefresh.tsx plus the
// `trigger === "update"` branch of the `jwt` callback in src/lib/auth.ts).
//
// The session is a JWT baked once at sign-in, so without this a promotion is
// invisible until the user signs out and back in — see src/app/sign-in/NOTES.md.
// Each test therefore checks both halves: that the change really is stale
// elsewhere, and that /dashboard is what unsticks it.
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { setTestUserRole, deleteTestUser } from "./db";

// The admin-only header link, i.e. proof that the *client* session (which
// SiteHeader reads via useSession) was refreshed, not just the server render.
// Scoped to the header on purpose: /dashboard renders its own "Manage users"
// link behind the same role check, and getByRole name matching is
// case-insensitive, so an unscoped locator matches both and trips strict mode.
const adminLink = (page: Page) => page.locator("header").getByRole("link", { name: "Manage Users" });

/**
 * Visits /dashboard and waits for its refresh to actually land.
 *
 * Both tests need this before touching the database, not only after: signing in
 * *redirects to /dashboard*, so a refresh is already in flight while the test
 * thinks it is merely making assertions. A `setTestUserRole` that lands inside
 * that window is picked up by the sign-in visit's own refresh, and the test then
 * fails claiming the change reached the session without /dashboard being
 * visited — when what really happened is that it was.
 *
 * The POST is the signal (`update({})`; a plain GET is the provider's ordinary
 * session read and never re-reads the DB — see SessionRefresh.tsx).
 */
async function visitDashboard(page: Page): Promise<void> {
  const refreshed = page.waitForResponse(
    (response) => response.url().includes("/api/auth/session") && response.request().method() === "POST",
  );
  await page.goto("/dashboard");
  await refreshed;
}

test("visiting /dashboard picks up a role change made after sign-in", async ({ secondUser }) => {
  const { user, page } = await secondUser({ role: "COMMENTER" });

  await visitDashboard(page);
  await expect(page.getByText("Role: COMMENTER")).toBeVisible();
  await expect(adminLink(page)).toHaveCount(0);

  await setTestUserRole(user.email, "ADMIN");

  // Anywhere else still renders from the stale JWT. SiteHeader shows signed-out
  // for a moment on every load (sign-in/NOTES.md), so wait for the name link it
  // renders before concluding anything from an *absent* link.
  await page.goto("/");
  await expect(page.getByRole("link", { name: user.name })).toBeVisible();
  await expect(adminLink(page)).toHaveCount(0);

  await visitDashboard(page);
  await expect(page.getByText("Role: ADMIN")).toBeVisible();
  await expect(adminLink(page)).toBeVisible();

  // And the refreshed cookie outlives the visit — the whole point of updating
  // the token rather than just reading the DB for the dashboard's own render.
  await page.goto("/");
  await expect(adminLink(page)).toBeVisible();
});

test("visiting /dashboard as a deleted user clears the session", async ({ secondUser }) => {
  const { user, page } = await secondUser({ role: "ADMIN" });

  await visitDashboard(page);
  await deleteTestUser(user.email);

  // The JWT is still valid and still says ADMIN — deleting the row doesn't
  // revoke it (CLAUDE.md's browser-pane note).
  await page.goto("/");
  await expect(adminLink(page)).toBeVisible();

  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/sign-in/);
});
