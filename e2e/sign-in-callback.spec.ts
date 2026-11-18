// Returning to where you were after signing in.
//
// The regression this pins: every gated surface redirected anonymous visitors
// to a bare `/sign-in`, which then always landed them on /dashboard — so a
// link to a doc, a post or an admin table sent a signed-out reader through a
// sign-in that lost the thing they had actually clicked. The destination now
// rides along as `?callbackUrl=`, built by `signInPath` at each gate
// (src/lib/sign-in-redirect.ts).
//
// The open-redirect case is the other half and matters more: the form calls
// `signIn(..., { redirect: false })` and navigates itself, so Auth.js's own
// same-origin `redirect` callback never runs and the validation is entirely
// `safeCallbackUrl`'s. Its unit tests cover the input table; what this file
// proves is that the validated value is what the browser actually follows.
import { test, expect } from "@playwright/test";
import {
  ADMIN_EMAIL,
  TEST_PASSWORD,
  createTestAnnotation,
  createTestDoc,
  deleteTestDoc,
  renameTestDocSlug,
} from "./db";
import { ADMIN_STORAGE_STATE } from "../playwright.config";

test.use({ storageState: { cookies: [], origins: [] } });

async function signIn(page: import("@playwright/test").Page) {
  await page.getByLabel("Email").fill(ADMIN_EMAIL);
  await page.getByLabel("Password").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("a gate names the page it turned you away from", async ({ page }) => {
  await page.goto("/docs");
  await page.waitForURL("**/sign-in?callbackUrl=*");
  expect(new URL(page.url()).searchParams.get("callbackUrl")).toBe("/docs");
});

test("signing in returns you to the page you asked for", async ({ page }) => {
  await page.goto("/docs");
  await page.waitForURL("**/sign-in?callbackUrl=*");
  await signIn(page);

  await page.waitForURL("**/docs");
  await expect(page.getByRole("heading", { name: "Docs", level: 1 })).toBeVisible();
});

test("an admin table keeps the filters it was opened with", async ({ page }) => {
  // The table's whole state is querystring-borne, so a callbackUrl that kept
  // only the pathname would return the reader to an unfiltered page 1.
  await page.goto("/docs?q=zzz-no-such-doc&pageSize=10");
  await page.waitForURL("**/sign-in?callbackUrl=*");
  expect(new URL(page.url()).searchParams.get("callbackUrl")).toBe("/docs?q=zzz-no-such-doc&pageSize=10");

  await signIn(page);
  await page.waitForURL("**/docs?*");
  const back = new URL(page.url());
  expect(back.pathname).toBe("/docs");
  expect(back.searchParams.get("q")).toBe("zzz-no-such-doc");
  expect(back.searchParams.get("pageSize")).toBe("10");
});

test("an offsite callbackUrl is refused, not followed", async ({ page }) => {
  await page.goto("/sign-in?callbackUrl=https%3A%2F%2Fevil.example%2Fphish");
  await signIn(page);

  await page.waitForURL("**/dashboard");
  expect(new URL(page.url()).hostname).not.toContain("evil.example");
});

test("a protocol-relative callbackUrl is refused, not followed", async ({ page }) => {
  // The one a `startsWith("/")` check alone would wave through.
  await page.goto("/sign-in?callbackUrl=%2F%2Fevil.example%2Fphish");
  await signIn(page);

  await page.waitForURL("**/dashboard");
  expect(new URL(page.url()).hostname).not.toContain("evil.example");
});

test("the header's Log in link carries the page you are reading", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("navigation").getByRole("link", { name: "Log in" }).click();

  await page.waitForURL("**/sign-in?callbackUrl=*");
  expect(new URL(page.url()).searchParams.get("callbackUrl")).toBe("/");
});

test("/sign-in itself never becomes a destination", async ({ page }) => {
  // Otherwise the header's link, rendered on /sign-in, would point at itself.
  await page.goto("/sign-in");
  await expect(page.getByRole("navigation").getByRole("link", { name: "Log in" })).toHaveAttribute(
    "href",
    "/sign-in",
  );
});

test("a card's permalink survives signing in and a redirect on the way", async ({ page, browser }) => {
  // A body long enough that a note below the article is out of view on
  // arrival, so landing on it is something the fragment did.
  const body = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} of a long doc.`).join("\n\n");
  const doc = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: body });
  try {
    const note = await createTestAnnotation({ docId: doc.id, authorEmail: ADMIN_EMAIL, bodyText: "E2E note to land on" });

    // The card's permalink, read off the card as the admin sees it.
    const admin = await browser.newContext({ storageState: ADMIN_STORAGE_STATE });
    const adminPage = await admin.newPage();
    await adminPage.goto(`/doc/${doc.slug}`);
    const fragment = await adminPage.locator(`[data-comment-id="${note.id}"] a[id]`).first().getAttribute("id");
    await admin.close();
    expect(fragment).toBeTruthy();

    // An old slug answers with a redirect, which a client-side navigation
    // would follow by committing a URL without the fragment.
    const newSlug = await renameTestDocSlug(doc.id);
    await page.goto(`/doc/${doc.slug}#${fragment}`);
    await page.waitForURL("**/sign-in?callbackUrl=*");
    await signIn(page);

    await expect(page).toHaveURL(new RegExp(`/doc/${newSlug}#${fragment}$`));
    await expect(page.locator(`[data-comment-id="${note.id}"]`)).toBeInViewport();
  } finally {
    await page.goto("about:blank").catch(() => {});
    await deleteTestDoc(doc.id);
  }
});
