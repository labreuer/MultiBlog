// The dashboard Settings card's three tiers (docs/DASHBOARD.md "Settings"):
// each gets a user of exactly that role, and the assertions are which
// controls exist and what a Save actually wrote.
import type { Browser, Page } from "@playwright/test";
import { test, expect, openDashboardCard, signIn } from "./fixtures";
import { createTestUser, deleteTestUser, getUserIdentityFields, uniqueEmail } from "./db";

// A fresh context per user, not the shared admin `page` — same cookie-jar
// reasoning as landing.spec.ts's copy of this helper.
async function signedInAs(browser: Browser, email: string): Promise<Page> {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await signIn(page, email);
  return page;
}

test("COMMENTER: renames themselves; author-tier fields and roster don't render", async ({ browser }) => {
  const email = uniqueEmail("settings-commenter");
  await createTestUser({ email, role: "COMMENTER" });
  let page: Page | null = null;

  try {
    page = await signedInAs(browser, email);
    await page.goto("/dashboard");
    await openDashboardCard(page, "Settings");

    await expect(page.getByLabel("Name")).toBeVisible();
    await expect(page.getByLabel("Initials")).toHaveCount(0);
    await expect(page.getByLabel("Author color")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Author colors" })).toHaveCount(0);

    await page.getByLabel("Name").fill("Renamed Commenter");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Saved.")).toBeVisible();

    const fields = await getUserIdentityFields(email);
    expect(fields?.name).toBe("Renamed Commenter");
  } finally {
    await page?.context().close();
    await deleteTestUser(email);
  }
});

test("AUTHOR: saves initials and author color; still no roster", async ({ browser }) => {
  const email = uniqueEmail("settings-author");
  await createTestUser({ email, role: "AUTHOR" });
  let page: Page | null = null;

  try {
    page = await signedInAs(browser, email);
    await page.goto("/dashboard");
    await openDashboardCard(page, "Settings");

    await page.getByLabel("Initials").fill("E2E");
    await page.getByLabel("Author color").fill("#a1b2c3");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Saved.")).toBeVisible();

    const fields = await getUserIdentityFields(email);
    expect(fields?.adminInitials).toBe("E2E");
    expect(fields?.color).toBe("#a1b2c3");

    // The roster is the EDITOR+ tier, not AUTHOR's.
    await expect(page.getByRole("heading", { name: "Author colors" })).toHaveCount(0);
  } finally {
    await page?.context().close();
    await deleteTestUser(email);
  }
});

test("EDITOR: sees the roster, listing EDITOR+ and not AUTHORs", async ({ browser }) => {
  const editorEmail = uniqueEmail("settings-editor");
  const authorEmail = uniqueEmail("settings-roster-author");
  // Prefixed names: the default (the email's local part) also appears in
  // the "Signed in as <email>" line (docs/DASHBOARD.md "e2e notes").
  const editor = await createTestUser({
    email: editorEmail,
    role: "EDITOR",
    name: `Roster Editor ${editorEmail.split("@")[0]}`,
  });
  const author = await createTestUser({
    email: authorEmail,
    role: "AUTHOR",
    name: `Roster Author ${authorEmail.split("@")[0]}`,
  });
  let page: Page | null = null;

  try {
    page = await signedInAs(browser, editorEmail);
    await page.goto("/dashboard");
    await openDashboardCard(page, "Settings");

    await expect(page.getByRole("heading", { name: "Author colors" })).toBeVisible();
    // Scoped to the card: the header greets the signed-in user by name
    // (docs/DASHBOARD.md "e2e notes").
    const settingsCard = page
      .locator("details")
      .filter({ has: page.getByRole("heading", { name: "Settings", exact: true }) });
    // Their own row (the roster's label is name-or-email); the AUTHOR-role
    // user has a color too but sits below the roster's EDITOR+ floor.
    await expect(settingsCard.getByText(editor.name)).toBeVisible();
    await expect(settingsCard.getByText(author.name)).toHaveCount(0);
  } finally {
    await page?.context().close();
    await deleteTestUser(editorEmail);
    await deleteTestUser(authorEmail);
  }
});
