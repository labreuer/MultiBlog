// Sign-in without JavaScript.
//
// The regression this pins: the form carried only an `onSubmit` handler and no
// function `action`, so with JS disabled the browser fell back to its default
// method of GET and submitted the password as a query-string parameter — landing
// it in the URL bar, browser history, the Referer header, and every access log
// in front of the app. See src/app/actions/sign-in.ts.
//
// Runs signed-out and with `javaScriptEnabled: false`, which overrides the
// chromium project's shared admin storage state for this file only.
import { test, expect } from "@playwright/test";
import { ADMIN_EMAIL, TEST_PASSWORD } from "./db";

test.use({ javaScriptEnabled: false, storageState: { cookies: [], origins: [] } });

test("the form posts rather than getting", async ({ page }) => {
  await page.goto("/sign-in");

  // Scoped to <main> — SiteHeader has a search form of its own, which is a
  // legitimate GET.
  const form = page.locator("main form");
  // React derives both from the function `action`. If someone drops the action
  // again, `method` reverts to GET and the password rides in the query string.
  await expect(form).toHaveAttribute("method", /post/i);
  await expect(form).toHaveAttribute("enctype", /multipart\/form-data/i);
});

test("signs in without JavaScript, leaking nothing into the URL", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(ADMIN_EMAIL);
  await page.getByLabel("Password").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();

  await page.waitForURL("**/dashboard");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();

  // The point of the whole exercise.
  expect(page.url()).not.toContain(TEST_PASSWORD);
  expect(page.url()).not.toContain("password");
});

test("shows the error after a failed no-JavaScript sign-in", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(ADMIN_EMAIL);
  await page.getByLabel("Password").fill("definitely-not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();

  // Server-rendered from `?error=1`, since `useSearchParams()` would never
  // resolve client-side for a browser that can't run React.
  await expect(page.getByText("Invalid email or password.")).toBeVisible();
  expect(page.url()).not.toContain("definitely-not-the-password");
});
