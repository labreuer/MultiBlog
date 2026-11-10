// Signing in on a browser that already holds someone else's session.
//
// Every session GET re-issues the cookie it was sent (src/app/sign-in/NOTES.md,
// "Every session GET re-issues the cookie"), so one that left before the
// sign-in and answers after it puts the previous account's cookie back, and
// the browser goes on as who it was. Under load that order happens by itself
// now and then; this spec arranges it, by putting the previous cookie back
// just before the first session read that follows the credentials POST. The
// form has to notice whose session it holds and sign in again
// (src/app/sign-in/sign-in-form.tsx).
import { test, expect } from "./fixtures";
import { TEST_PASSWORD, createTestUser, deleteTestUser, uniqueEmail } from "./db";

test("a session read that answers after the sign-in does not undo it", async ({ page, context }) => {
  const email = uniqueEmail("stale-session");
  const name = `Stale Session ${email.split("@")[0]}`;
  await createTestUser({ email, name, role: "AUTHOR" });

  try {
    await page.goto("/sign-in");
    // The page's own session reads re-issue the admin's cookie too. Let them
    // finish, so the only cookie that comes back late is the one put back below.
    await page.waitForLoadState("networkidle");
    const previous = (await context.cookies()).filter((cookie) => cookie.name.includes("session-token"));
    expect(previous.length).toBeGreaterThan(0);

    let signIns = 0;
    let restored = false;
    await page.route("**/api/auth/**", async (route) => {
      const request = route.request();
      const { pathname } = new URL(request.url());
      if (request.method() === "POST" && pathname.endsWith("/callback/credentials")) {
        signIns += 1;
      } else if (request.method() === "GET" && pathname.endsWith("/session") && signIns > 0 && !restored) {
        // The first read after the sign-in: `signIn` issues it only once the
        // POST has answered, so the new account's cookie is in the jar, and a
        // continued request goes out with whatever the jar holds then.
        restored = true;
        await context.addCookies(previous);
      }
      await route.continue();
    });

    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(TEST_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();

    await page.waitForURL("**/dashboard");
    // The dashboard names the role beside the account: the admin's would read
    // "(ADMIN)".
    await expect(page.getByText("(AUTHOR)")).toBeVisible();
    await expect(page.locator("header").getByRole("link", { name })).toBeVisible();
    // Both, or the lines above prove nothing about the race: the previous
    // cookie was put back, and it took a second sign-in to replace it.
    expect(restored).toBe(true);
    expect(signIns).toBe(2);
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await context.clearCookies();
    await deleteTestUser(email);
  }
});
