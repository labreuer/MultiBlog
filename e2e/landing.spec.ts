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
import { test, expect, freshGoto, signIn } from "./fixtures";
import { createTestUser, deleteTestUser, getAvatarFacts, getContributorFields, uniqueEmail } from "./db";

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

/**
 * One contributor's card in the sidebar.
 *
 * Every assertion about a card's links has to go through this rather than
 * through `aside` directly: the sample data (scripts/seed-sample-data.ts)
 * seeds real contributors with their own ORCID/website links and avatars, so
 * an unscoped `aside.getByRole("link", { name: "ORCID iD" })` matches
 * whatever else is listed and trips strict mode. The spec must not depend on
 * whether a dev database happens to be seeded.
 */
function cardFor(page: Page, slug: string) {
  return page.locator(`[data-contributor-slug="${slug}"]`);
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
    // freshGoto, not goto: these contributors were written straight to the DB,
    // so on the prod target `/`'s ISR cache from an earlier test's visit would
    // still be serving a render without them (fixtures.ts's freshGoto comment).
    await freshGoto(page, "/");
    const card = cardFor(page, listed.slug);
    await expect(card.getByRole("link", { name: listed.name })).toBeVisible();
    await expect(card.getByRole("link", { name: "ORCID iD" })).toHaveAttribute(
      "href",
      "https://orcid.org/0000-0002-1825-0097",
    );
    // createTestUser writes fields straight to the DB, not through
    // normalizeWebsite (that's the dashboard-panel test's job to exercise) —
    // so the href is exactly what was set, with no trailing slash added.
    await expect(card.getByRole("link", { name: "Website" })).toHaveAttribute("href", "https://example.com");
    await expect(cardFor(page, unlisted.slug)).toHaveCount(0);
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
    // freshGoto for the same reason as the sidebar test above: the
    // contributor exists only as a direct DB write.
    await freshGoto(page, "/");
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
    const card = cardFor(page, user.slug);
    await expect(card.getByRole("link", { name: user.name })).toBeVisible();
    await expect(card.getByRole("link", { name: "ORCID iD" })).toHaveAttribute(
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
    await expect(cardFor(page, user.slug)).toHaveCount(0);
  } finally {
    await contributorPage?.context().close();
    await deleteTestUser(email);
  }
});

// A deliberately non-square PNG, built in-process so the spec owns its own
// fixture rather than depending on a checked-in binary. 600x300 is enough to
// prove the server resized *and* squared it; the payload is a valid PNG that
// sharp will happily decode.
async function makeTestPng(page: Page): Promise<Buffer> {
  const dataUrl = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 600;
    canvas.height = 300;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#0a5";
    ctx.fillRect(0, 0, 600, 300);
    ctx.fillStyle = "#fff";
    ctx.fillRect(40, 40, 220, 220);
    return canvas.toDataURL("image/png");
  });
  return Buffer.from(dataUrl.split(",")[1], "base64");
}

test("avatar upload: re-encodes and resizes, serves immutably, and removal falls back to initials", async ({
  page,
  browser,
}) => {
  const email = uniqueEmail("avatar-contributor");
  const user = await createTestUser({
    email,
    name: `Avatar Contributor ${email.split("@")[0]}`,
    isListedContributor: true,
  });
  let contributorPage: Page | null = null;

  try {
    contributorPage = await signedInAs(browser, email);
    await contributorPage.goto("/dashboard");
    await expect(contributorPage.getByRole("heading", { name: "Contributor profile" })).toBeVisible();

    // No avatar yet → the initials circle, and nothing to remove.
    await expect(contributorPage.getByRole("button", { name: "Remove photo" })).toHaveCount(0);

    const png = await makeTestPng(contributorPage);
    await contributorPage.getByLabel("Photo").setInputFiles({ name: "avatar.png", mimeType: "image/png", buffer: png });
    // Picking a file opens the cropper rather than uploading (PLAN.md §17n);
    // confirming it is what posts. The positioning itself is exercised by
    // avatar-crop.spec.ts — here the default crop is all this needs.
    await contributorPage.getByRole("button", { name: "Use this photo" }).click();
    await expect(contributorPage.getByRole("button", { name: "Remove photo" })).toBeVisible();

    // Stored re-encoded and squared, never as the bytes that were uploaded
    // (PLAN.md §17n) — this is also what proves EXIF can't survive.
    const facts = await getAvatarFacts(email);
    expect(facts).not.toBeNull();
    expect(facts!.contentType).toBe("image/webp");
    expect(facts!.width).toBe(160);
    expect(facts!.height).toBe(160);

    // The public page serves it from the content-hashed route, immutably.
    await page.goto("/");
    const avatar = cardFor(page, user.slug).locator("img");
    await expect(avatar).toHaveAttribute("src", `/api/avatar/${user.id}/${facts!.hash}`);
    // It actually decodes — a broken <img> would still satisfy the attribute.
    await expect
      .poll(() => avatar.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
      .toBe(160);

    const response = await page.request.get(`/api/avatar/${user.id}/${facts!.hash}`);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("image/webp");
    expect(response.headers()["cache-control"]).toContain("immutable");
    expect(response.headers()["etag"]).toBe(`"${facts!.hash}"`);

    // A URL carrying a hash that is no longer current still serves the
    // person's actual avatar (so HTML cached inside `/`'s 60s ISR window
    // doesn't show a broken image) but stops claiming immutability.
    const stale = await page.request.get(`/api/avatar/${user.id}/${"0".repeat(32)}`);
    expect(stale.status()).toBe(200);
    expect(stale.headers()["cache-control"]).toContain("must-revalidate");

    // Removal falls back to the colored initials circle.
    await contributorPage.getByRole("button", { name: "Remove photo" }).click();
    await expect(contributorPage.getByRole("button", { name: "Remove photo" })).toHaveCount(0);
    expect(await getAvatarFacts(email)).toBeNull();

    await page.goto("/");
    const cardAfterRemoval = cardFor(page, user.slug);
    await expect(cardAfterRemoval.getByRole("link", { name: user.name })).toBeVisible();
    await expect(cardAfterRemoval.locator("img")).toHaveCount(0);
  } finally {
    await contributorPage?.context().close();
    await deleteTestUser(email);
  }
});
