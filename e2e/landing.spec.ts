// The landing page (PLAN.md §17): a doc-sourced preamble, the latest
// published posts, and an opt-in contributor sidebar with self-service
// editing on /dashboard.
//
// What this deliberately does NOT assert: specific preamble text. §17c's
// first-created-wins tie-break means a doc this spec creates loses to any
// pre-existing "FRONT PAGE" doc (a real deployment, or scripts/seed-front-
// page.ts having already run) — the same class of problem
// admin-table.spec.ts hit against the site-wide column-order default. So the
// only assertion here is the one that holds regardless of which doc won:
// the literal title string never reaches the page.
//
// The banner is also untested here — it's an env var (SITE_BANNER) plus a
// gitignored file, not app state this suite's fixtures control either way.
import type { Browser, Page } from "@playwright/test";
import { test, expect, signIn } from "./fixtures";
import { createTestUser, deleteTestUser, getContributorFields, uniqueEmail } from "./db";

// A fresh browser context, not the shared `page`'s — the browser pane's
// "tabs share one cookie jar" trap (CLAUDE.md) applies to Playwright pages
// in the same context too; a separate context is what secondUser() uses for
// exactly this reason.
async function signedInAs(browser: Browser, email: string): Promise<Page> {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const contributorPage = await context.newPage();
  await signIn(contributorPage, email);
  return contributorPage;
}

test("never shows the FRONT PAGE doc's own title", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("FRONT PAGE", { exact: true })).toHaveCount(0);
});

test("contributor sidebar lists an opted-in contributor and omits everyone else", async ({ page }) => {
  const listedEmail = uniqueEmail("contributor");
  const unlistedEmail = uniqueEmail("noncontributor");
  const listed = await createTestUser({
    email: listedEmail,
    name: `Listed Contributor ${listedEmail.split("@")[0]}`,
    isListedContributor: true,
    orcid: "0000-0002-1825-0097",
    website: "https://example.com",
  });
  const unlisted = await createTestUser({
    email: unlistedEmail,
    name: `Unlisted Person ${unlistedEmail.split("@")[0]}`,
    isListedContributor: false,
  });

  try {
    await page.goto("/");
    const aside = page.locator("aside");
    await expect(aside.getByRole("link", { name: listed.name })).toBeVisible();
    await expect(aside.getByRole("link", { name: "ORCID iD" })).toHaveAttribute(
      "href",
      "https://orcid.org/0000-0002-1825-0097",
    );
    // createTestUser writes fields straight to the DB, not through
    // normalizeWebsite (that's the dashboard-panel test's job to exercise) —
    // so the href is exactly what was set, with no trailing slash added.
    await expect(aside.getByRole("link", { name: "Website" })).toHaveAttribute("href", "https://example.com");
    await expect(aside.getByRole("link", { name: unlisted.name })).toHaveCount(0);
  } finally {
    await deleteTestUser(listedEmail);
    await deleteTestUser(unlistedEmail);
  }
});

test("contributor sidebar moves below the post list under 900px", async ({ page }) => {
  const email = uniqueEmail("narrow-contributor");
  const user = await createTestUser({ email, name: `Narrow Contributor ${email.split("@")[0]}`, isListedContributor: true });

  try {
    await page.setViewportSize({ width: 500, height: 900 });
    await page.goto("/");
    const main = page.locator("main");
    const aside = page.locator("aside");
    await expect(aside.getByRole("link", { name: user.name })).toBeVisible();

    const mainBox = await main.boundingBox();
    const asideBox = await aside.boundingBox();
    expect(mainBox).not.toBeNull();
    expect(asideBox).not.toBeNull();
    // Single-column grid: the aside sits below main, not beside it.
    expect(asideBox!.y).toBeGreaterThanOrEqual(mainBox!.y + mainBox!.height - 1);
  } finally {
    await deleteTestUser(email);
  }
});

test("dashboard panel: self-service edits reach the front page; opting out clears the flag and hides the panel", async ({
  page,
  browser,
}) => {
  const email = uniqueEmail("panel-contributor");
  const user = await createTestUser({ email, name: `Panel Contributor ${email.split("@")[0]}`, isListedContributor: true });
  let contributorPage: Page | null = null;

  try {
    contributorPage = await signedInAs(browser, email);
    await contributorPage.goto("/dashboard");
    await expect(contributorPage.getByRole("heading", { name: "Contributor profile" })).toBeVisible();

    await contributorPage.getByLabel("ORCID iD").fill("0000-0002-1825-0097");
    await contributorPage.getByLabel("Website").fill("https://example.com");
    await contributorPage.getByRole("button", { name: "Save" }).click();
    await expect(contributorPage.getByText("Saved.")).toBeVisible();

    const fields = await getContributorFields(email);
    expect(fields?.orcid).toBe("0000-0002-1825-0097");
    expect(fields?.website).toBe("https://example.com/");

    await page.goto("/");
    const aside = page.locator("aside");
    await expect(aside.getByRole("link", { name: user.name })).toBeVisible();
    await expect(aside.getByRole("link", { name: "ORCID iD" })).toHaveAttribute(
      "href",
      "https://orcid.org/0000-0002-1825-0097",
    );

    // Opt-out (PLAN.md §17h) — inline two-step confirm, not window.confirm.
    await contributorPage.getByRole("button", { name: "Remove me from the contributor list" }).click();
    await contributorPage.getByRole("button", { name: "Yes, remove me" }).click();
    await expect(contributorPage.getByRole("heading", { name: "Contributor profile" })).toHaveCount(0);

    const afterOptOut = await getContributorFields(email);
    expect(afterOptOut?.isListedContributor).toBe(false);

    await page.goto("/");
    await expect(page.locator("aside").getByRole("link", { name: user.name })).toHaveCount(0);
  } finally {
    await contributorPage?.context().close();
    await deleteTestUser(email);
  }
});
