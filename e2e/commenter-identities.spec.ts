import type { Browser, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  createComment,
  getTestCommenters,
  getTestEmailCollisions,
  logTestEmailCollision,
} from "./db";

// docs/COMMENTS.md, "Identities kept apart" — nobody comments as anybody
// else, and every place an account and an anonymous commenter meet on one
// email is logged for an ADMIN at /email-collisions.
//
// **Every request here names its own IP address**, in `X-Real-IP`. The suite
// has no nginx in front of it, so the header reaches the app as sent
// (src/lib/client-ip.ts), which is how a test gives a second request "another
// IP address". It also keeps the real form's comments off the address every
// other spec shares, and its limit of five per ten minutes. Each address is
// fresh per run, from the IPv6 documentation range, so a rerun within the
// limiter's window meets no comments of its own.
//
// The fixture accounts' emails, and the meetings logged on them, are deleted
// with the accounts (`deleteAccount` in e2e/db-worker.ts).

const REFUSAL = "An account uses this email. Sign in to comment with it.";

function freshIp(): string {
  const group = () => Math.floor(Math.random() * 0x10000).toString(16);
  return `2001:db8::${group()}:${group()}:${group()}`;
}

async function asIp(page: Page, ip: string): Promise<void> {
  // Replaces the context's extra headers wholesale, so the fixture's own
  // no-cache (e2e/fixtures.ts) is restated.
  await page.context().setExtraHTTPHeaders({ "Cache-Control": "no-cache", "X-Real-IP": ip });
}

async function signedOutPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  return context.newPage();
}

/**
 * Fills and submits the signed-out form. The name and email are refilled
 * every time: a form action resets its uncontrolled inputs when it returns.
 */
async function postSignedOut(page: Page, email: string, body: string): Promise<void> {
  await page.getByPlaceholder("Name").fill("Somebody Else");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByRole("textbox", { name: "Comment body" }).fill(body);
  await page.getByRole("button", { name: "Post comment" }).click();
}

test.describe("commenter identities", () => {
  test("a signed-out comment giving an account's email is refused, and logged once per email", async ({
    browser,
    secondUser,
    publishedModeratedPost,
  }) => {
    const { user } = await secondUser({ role: "COMMENTER" });
    const visitor = await signedOutPage(browser);
    try {
      const first = freshIp();
      await asIp(visitor, first);
      await visitor.goto(publishedModeratedPost.path);

      // In another case: the comparison ignores it.
      await postSignedOut(visitor, user.email.toUpperCase(), "Posting as someone I am not.");
      await expect(visitor.getByText(REFUSAL)).toBeVisible();
      expect(await getTestEmailCollisions(user.email)).toMatchObject([
        {
          source: "SIGNED_OUT_COMMENT",
          email: user.email.toUpperCase(),
          count: 1,
          userId: user.id,
          commenterId: null,
          postId: publishedModeratedPost.id,
          ipAddresses: [first],
          reviewed: false,
        },
      ]);
      // Refused before any identity was made.
      expect(await getTestCommenters(user.email)).toEqual([]);

      // A second try from another address folds into the same row.
      const second = freshIp();
      await asIp(visitor, second);
      await visitor.goto(publishedModeratedPost.path);
      await postSignedOut(visitor, user.email, "Trying again from elsewhere.");
      await expect(visitor.getByText(REFUSAL)).toBeVisible();
      expect(await getTestEmailCollisions(user.email)).toMatchObject([
        { source: "SIGNED_OUT_COMMENT", count: 2, ipAddresses: [first, second] },
      ]);

      // An email differing from the account's only where it has a `_` is
      // somebody else's: an `ILIKE` would read the `_` as a wildcard and
      // refuse it. The account's email is `e2e-second-<n>-<x>@example.com`
      // (uniqueEmail), and this keeps the `e2e-` the sweep looks for.
      const lookalike = user.email.replace("-second-", "-second_");
      expect(lookalike).not.toBe(user.email);
      await postSignedOut(visitor, lookalike, "A different person entirely.");
      await expect(visitor.getByText("Your comment is awaiting moderation.")).toBeVisible();
      expect(await getTestEmailCollisions(user.email)).toMatchObject([{ count: 2 }]);
      expect(await getTestEmailCollisions(lookalike)).toEqual([]);
    } finally {
      await visitor.context().close();
    }
  });

  test("a signed-in commenter whose email an anonymous identity holds gets a row of their own", async ({
    secondUser,
    publishedPost,
  }) => {
    const { user, page } = await secondUser({ role: "COMMENTER" });
    const anonymousBody = "An anonymous comment from before the account.";
    const anonymous = await createComment({
      postId: publishedPost.id,
      anchoredEventId: publishedPost.eventId!,
      email: user.email,
      displayName: "Earlier Anonymous",
      body: anonymousBody,
      status: "APPROVED",
      anonymous: true,
      ipAddress: freshIp(),
    });

    const ip = freshIp();
    await asIp(page, ip);
    await page.goto(publishedPost.path);
    const ownRow = async () => (await getTestCommenters(user.email)).find((row) => row.userId === user.id);

    await page.getByRole("textbox", { name: "Comment body" }).fill("My first comment, signed in.");
    await page.getByRole("button", { name: "Post comment" }).click();
    await expect.poll(async () => (await ownRow())?.comments).toEqual(["My first comment, signed in."]);

    // Two rows on one email, kept apart: the anonymous comment stays where it was.
    const commenters = await getTestCommenters(user.email);
    expect(commenters).toHaveLength(2);
    expect(commenters.find((row) => row.userId === null)).toEqual({
      id: anonymous.commenterId,
      userId: null,
      comments: [anonymousBody],
    });
    expect(await getTestEmailCollisions(user.email)).toMatchObject([
      {
        source: "SIGNED_IN_COMMENT",
        count: 1,
        userId: user.id,
        commenterId: anonymous.commenterId,
        postId: publishedPost.id,
        ipAddresses: [ip],
      },
    ]);

    // Logged when the row is made, not on every comment after.
    await page.goto(publishedPost.path);
    await page.getByRole("textbox", { name: "Comment body" }).fill("And a second one.");
    await page.getByRole("button", { name: "Post comment" }).click();
    await expect.poll(async () => (await ownRow())?.comments.length).toBe(2);
    expect(await getTestEmailCollisions(user.email)).toMatchObject([{ source: "SIGNED_IN_COMMENT", count: 1 }]);
  });

  test("the review page lists the meetings with their comments' addresses, and marking them reviewed takes them off", async ({
    page,
    secondUser,
    publishedPost,
  }) => {
    const { user } = await secondUser({ role: "COMMENTER" });
    const commentIp = freshIp();
    const anonymous = await createComment({
      postId: publishedPost.id,
      anchoredEventId: publishedPost.eventId!,
      email: user.email,
      displayName: "Earlier Anonymous",
      body: "An anonymous comment the review page reads the address of.",
      status: "APPROVED",
      anonymous: true,
      ipAddress: commentIp,
    });
    const refusedIp = freshIp();
    const signedInIp = freshIp();
    const meeting = { email: user.email, userId: user.id, commenterId: anonymous.commenterId, postId: publishedPost.id };
    await logTestEmailCollision({ ...meeting, source: "SIGNED_OUT_COMMENT", ipAddress: refusedIp });
    await logTestEmailCollision({ ...meeting, source: "SIGNED_IN_COMMENT", ipAddress: signedInIp });

    // Narrowed to this test's email, so other workers' rows can't make a row
    // ambiguous.
    await page.goto(`/email-collisions?q=${encodeURIComponent(user.email)}`);
    const refused = page.getByRole("row").filter({ hasText: "Signed-out comment" });
    const signedIn = page.getByRole("row").filter({ hasText: "Signed-in comment" });
    await expect(refused).toHaveCount(1);
    await expect(signedIn).toHaveCount(1);
    // The request's address from the row, the anonymous comment's through
    // the view, read live from `comment.ip_address`.
    await expect(refused).toContainText(refusedIp);
    await expect(refused).toContainText(commentIp);
    await expect(signedIn).toContainText(signedInIp);

    // One by its own button…
    await signedIn.getByRole("button", { name: "Mark reviewed" }).click();
    await expect(signedIn).toHaveCount(0);
    await expect(refused).toHaveCount(1);

    // …and the rest in bulk.
    await refused.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Mark selected reviewed" }).click();
    await expect(page.getByText("No email collisions waiting for review.")).toBeVisible();
    expect((await getTestEmailCollisions(user.email)).map((row) => row.reviewed)).toEqual([true, true]);

    // Still there, behind the toggle. A click and the URL, not `check()`: the
    // box is the querystring's, so it flips only once the navigation lands,
    // and `check()` gives up on a box that hasn't changed when it looks.
    await page.getByLabel("Show reviewed rows").click();
    await expect(page).toHaveURL(/[?&]reviewed=1/);
    await expect(page.getByLabel("Show reviewed rows")).toBeChecked();
    await expect(refused).toHaveCount(1);
    await expect(signedIn).toHaveCount(1);
  });
});
