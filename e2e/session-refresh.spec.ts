// A session and the account it was signed in as (src/app/sign-in/NOTES.md).
//
// The session is a JWT that says when its account was last read, and the
// `jwt` callback in src/lib/auth.ts reads the account again once that is
// older than the interval (five minutes), on whatever page the next request
// is for. /dashboard asks for the same read at once, on every visit
// (src/components/SessionRefresh.tsx, `trigger === "update"`).
//
// So each change is checked three ways: inside the interval it has not
// reached the session; /dashboard delivers it at once; and a session past its
// interval gets it on any page. That last one is arranged, not waited for:
// `ageSession` moves the token's own `checkedAt` back, which also keeps every
// other spec's sessions as they are, at the server's ordinary interval.
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { setTestUserRole, deleteTestUser } from "./db";
import { ageSession, rewriteSessionClaims, sessionClaims } from "./session-token";

// The admin-only header link, i.e. proof that the *client* session (which
// SiteHeader reads via useSession) was refreshed, not just the server render.
// Scoped to the header on purpose: getByRole name matching is
// case-insensitive *and* substring-based, so any page content containing
// "Users" matches too and trips strict mode — /dashboard's own "Manage
// users" link did exactly that until the top menu replaced it (2026-08-27),
// and the scope keeps this meaning "the header nav's link" whatever the
// page body grows next.
const adminLink = (page: Page) => page.locator("header").getByRole("link", { name: "Users", exact: true });

/**
 * Visits /dashboard and waits for its refresh to actually land.
 *
 * Every test here needs this before touching the database, not only after: signing in
 * *redirects to /dashboard*, so a refresh is already in flight while the test
 * thinks it is merely making assertions. A `setTestUserRole` that lands inside
 * that window is picked up by the sign-in visit's own refresh, and the test then
 * fails claiming the change reached the session without /dashboard being
 * visited — when what really happened is that it was.
 *
 * The POST is the signal (`update({})`; a plain GET is the provider's ordinary
 * session read, which reads the account only for a token past its interval —
 * see SessionRefresh.tsx).
 */
async function visitDashboard(page: Page): Promise<void> {
  // One POST is not the whole story against the prod target: the post-sign-in
  // redirect can reach /dashboard as two loads (an RSC navigation and a full
  // document load), and each mounts its own SessionRefresh — so a second
  // update POST can trail the first by hundreds of milliseconds. A test that
  // mutates the user row in that gap races it both ways: trace-verified, a
  // trailing POST processed after deleteTestUser nulled the session early,
  // and one processed after setTestUserRole delivered the new role *without*
  // the /dashboard visit the test is about. So rather than awaiting one
  // response, settle until the session endpoint has been quiet — no update
  // POST in flight and none finished for a beat — which is target-shape
  // agnostic (the dev target's single mount just pays the quiet interval).
  // Quiet-time only, deliberately no in-flight bookkeeping: when the two
  // mounts' POSTs race, next-auth aborts one client-side, and an aborted
  // fetch can emit no requestfinished/requestfailed at all — an in-flight
  // counter then sticks above zero forever (observed: two `request` events,
  // one completion). Every observed event just restamps the clock; the POSTs
  // themselves complete in well under 100ms, so 1.5s of silence after the
  // last one is comfortably "no refresh is still coming".
  const isRefresh = (u: string, method: string) => u.includes("/api/auth/session") && method === "POST";
  let lastActivity = Date.now();
  let seen = 0;
  const stamp = (request: import("@playwright/test").Request) => {
    if (isRefresh(request.url(), request.method())) {
      seen += 1;
      lastActivity = Date.now();
    }
  };
  const restamp = (request: import("@playwright/test").Request) => {
    if (isRefresh(request.url(), request.method())) {
      lastActivity = Date.now();
    }
  };
  page.on("request", stamp);
  page.on("requestfinished", restamp);
  page.on("requestfailed", restamp);
  try {
    await page.goto("/dashboard");
    await expect.poll(() => seen > 0 && Date.now() - lastActivity >= 1_500, { timeout: 20_000 }).toBe(true);
  } finally {
    page.off("request", stamp);
    page.off("requestfinished", restamp);
    page.off("requestfailed", restamp);
  }
}

/**
 * Waits for the page's own reads of the session to finish. Each re-issues the
 * cookie it was sent (sign-in/NOTES.md), so a token rewritten while one is
 * still in flight would be put back as it was when that one answers.
 */
async function sessionReadsDone(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle");
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

test("visiting /dashboard picks up a role change made after sign-in", async ({ secondUser }) => {
  const { user, page } = await secondUser({ role: "COMMENTER" });

  await visitDashboard(page);
  await expect(page.getByText("(COMMENTER)")).toBeVisible();
  await expect(adminLink(page)).toHaveCount(0);

  await setTestUserRole(user.email, "ADMIN");

  // Anywhere else still renders from the token, which is inside its interval
  // and so is not read again. SiteHeader shows signed-out for a moment on every
  // load (sign-in/NOTES.md), so wait for the name link it renders before
  // concluding anything from an *absent* link.
  await page.goto("/");
  await expect(page.getByRole("link", { name: user.name })).toBeVisible();
  await expect(adminLink(page)).toHaveCount(0);

  await visitDashboard(page);
  await expect(page.getByText("(ADMIN)")).toBeVisible();
  await expect(adminLink(page)).toBeVisible();

  // And the refreshed cookie outlives the visit — the whole point of updating
  // the token rather than just reading the DB for the dashboard's own render.
  await page.goto("/");
  await expect(adminLink(page)).toBeVisible();
});

test("a promotion reaches a session past its interval on any page, without /dashboard", async ({ secondUser }) => {
  const { user, page } = await secondUser({ role: "COMMENTER" });
  const context = page.context();

  await visitDashboard(page);
  // Signing in, and /dashboard's read after it, each say when they read the account.
  const stamped = (await sessionClaims(context))?.checkedAt;
  expect(typeof stamped).toBe("number");
  expect(Math.abs(nowSeconds() - (stamped as number))).toBeLessThan(120);

  await setTestUserRole(user.email, "ADMIN");

  // Inside the interval the account is not read again, on any page.
  await page.goto("/");
  await expect(page.getByRole("link", { name: user.name })).toBeVisible();
  await expect(adminLink(page)).toHaveCount(0);
  await sessionReadsDone(page);
  expect((await sessionClaims(context))?.role).toBe("COMMENTER");

  // Past it, the first request's own gate sees the account as it is now:
  // /users is an ADMIN's, and tells anyone else so.
  await ageSession(context);
  await page.goto("/users");
  await expect(page.getByRole("heading", { name: "Users", exact: true })).toBeVisible();
  await expect(page.getByText("permission to manage users")).toHaveCount(0);
  // The client's read of the session got the same, so the header has the link,
  await expect(adminLink(page)).toBeVisible();
  // and wrote the token back with the role and the time of this read, so the
  // account is not read again on every request from here.
  await expect.poll(async () => (await sessionClaims(context))?.role).toBe("ADMIN");
  const reread = (await sessionClaims(context))?.checkedAt as number;
  expect(nowSeconds() - reread).toBeLessThan(120);
});

test("visiting /dashboard as a deleted user clears the session", async ({ secondUser }) => {
  const { user, page } = await secondUser({ role: "ADMIN" });

  await visitDashboard(page);
  await deleteTestUser(user.email);

  // The token is inside its interval and still says ADMIN: deleting the row
  // reaches it at its next read of the account, not before.
  await page.goto("/");
  await expect(adminLink(page)).toBeVisible();

  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/sign-in/);
});

test("a deletion reaches a session past its interval on any page, and ends it", async ({ secondUser }) => {
  const { user, page } = await secondUser({ role: "ADMIN" });
  const context = page.context();

  await visitDashboard(page);
  await deleteTestUser(user.email);

  // Inside the interval the deleted account's session still works.
  await page.goto("/");
  await expect(adminLink(page)).toBeVisible();
  await sessionReadsDone(page);

  // Past it, the first gate to read the session finds no account and sends
  // the browser to sign in, on a page that isn't /dashboard,
  await ageSession(context);
  await page.goto("/users");
  await expect(page).toHaveURL(/\/sign-in/);
  // and the client's read of the session there clears the cookie.
  await expect.poll(() => sessionClaims(context)).toBeNull();
});

test("a token from before it said when its account was read is read again at once, and comes back whole", async ({ secondUser }) => {
  const { page } = await secondUser({ role: "AUTHOR", adminInitials: "LG" });
  const context = page.context();

  await visitDashboard(page);
  await page.goto("/");
  await sessionReadsDone(page);

  // A token as one issued before `checkedAt` and `adminInitials` rode on it.
  await rewriteSessionClaims(context, (claims) => {
    delete claims.checkedAt;
    delete claims.adminInitials;
  });
  const old = await sessionClaims(context);
  expect(old).not.toHaveProperty("checkedAt");
  expect(old).not.toHaveProperty("adminInitials");

  // Its first read of the session is a read of the account, which fills in
  // whatever the token lacked, and the cookie that read writes has both.
  const session = await page.request.get("/api/auth/session", { maxRetries: 2 });
  expect((await session.json()).user.adminInitials).toBe("LG");
  const now = await sessionClaims(context);
  expect(now?.adminInitials).toBe("LG");
  expect(nowSeconds() - (now?.checkedAt as number)).toBeLessThan(120);
});

// "visiting /dashboard as a deleted user" meets this only when load orders two
// answers a certain way; this one arranges it. Every session GET re-issues the cookie it was sent
// (src/app/sign-in/NOTES.md), and the provider always has one in flight beside
// SessionRefresh's POST, so the cookie that POST cleared can come back a moment
// later. Putting the cookie back here, just before the read SessionRefresh
// confirms with, is that answer landing at the worst possible time. The cookie
// put back is inside its interval, so nothing but SessionRefresh's second
// update would end the session before the interval runs out.
test("a session read that answers after the clearing does not keep a deleted user signed in", async ({ secondUser }) => {
  const { user, page } = await secondUser({ role: "ADMIN" });
  const context = page.context();

  await visitDashboard(page);
  await deleteTestUser(user.email);

  let live: Awaited<ReturnType<typeof context.cookies>> = [];
  let restored = false;
  let updates = 0;
  await page.route("**/api/auth/session", async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      updates += 1;
      // What the clearing is about to take away.
      if (!restored) {
        live = (await context.cookies()).filter((cookie) => cookie.name.includes("session-token"));
      }
    } else if (!restored && live.length > 0 && !("content-type" in request.headers())) {
      // SessionRefresh's own confirming read, told from next-auth's by its
      // headers: `fetchData` sends a Content-Type on a GET and a bare `fetch`
      // does not. It leaves only once the POST has answered, so the cookie is
      // certainly gone by now, and it goes out with whatever the jar holds
      // when it is continued.
      restored = true;
      await context.addCookies(live);
    }
    await route.continue();
  });

  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/sign-in/);
  // Both, or the redirect above proves nothing about the race: the cookie was
  // put back, and it took a second update to clear it again.
  expect(restored).toBe(true);
  expect(updates).toBe(2);
  expect((await context.cookies()).filter((cookie) => cookie.name.includes("session-token"))).toEqual([]);
});
