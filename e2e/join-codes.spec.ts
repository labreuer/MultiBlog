import type { Browser, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  ageTestJoinSend,
  deleteTestDoc,
  deleteTestJoinBatch,
  deleteTestUser,
  ensureTestWelcomePage,
  getTestCommenters,
  getTestEmailCollisions,
  getTestJoinAccount,
  getTestJoinCode,
  hasTestResetToken,
  createComment,
  createTestWikiPage,
  mintTestJoinBatch,
  renameWikiPageAs,
  setTestJoinClaimToken,
  setTestJoinState,
  welcomeTextFor,
  writeTestWikiColumns,
  uniqueEmail,
} from "./db";

// docs/EMAIL.md §10 — a one-off join card, from the scan to the account.
// Every context here starts with no session, and no mail is read: every
// address is @example.com, which src/lib/mail.ts never delivers to and
// reports as delivered (docs/EMAIL.md §2). The batches are minted through the
// app's own mintJoinBatch, so the codes are derived from the rows under this
// .env's AUTH_SECRET, as the server derives them; a claim's link is then
// given a token the spec knows (`setTestJoinClaimToken`), as invite.spec.ts
// mints its invite.
//
// Each request names its own IP address in `X-Real-IP`, as
// commenter-identities.spec.ts does, so the claim's and the confirmation's
// addresses can be told apart in the log, and the comment below is off the
// address every other spec shares.

const PASSWORD = "card-password-123";

function freshIp(): string {
  const group = () => Math.floor(Math.random() * 0x10000).toString(16);
  return `2001:db8::${group()}:${group()}:${group()}`;
}

async function freshPage(browser: Browser, ip: string = freshIp()): Promise<Page> {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  await context.setExtraHTTPHeaders({ "Cache-Control": "no-cache", "X-Real-IP": ip });
  return context.newPage();
}

async function asIp(page: Page, ip: string): Promise<void> {
  await page.context().setExtraHTTPHeaders({ "Cache-Control": "no-cache", "X-Real-IP": ip });
}

/** A name no other account has: the card refuses one an account goes by. */
function uniqueName(): string {
  return `E2E Card ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function claim(page: Page, code: string, fields: { name: string; email: string; password?: string }): Promise<void> {
  await page.goto(`/join/${code}`);
  await page.getByLabel("Your name, as others will see it").fill(fields.name);
  await page.getByLabel("Email").fill(fields.email);
  await page.getByLabel("Choose a password").fill(fields.password ?? PASSWORD);
  await page.getByRole("button", { name: "Send the link" }).click();
}

async function confirm(page: Page, link: string, password: string = PASSWORD): Promise<void> {
  await page.goto(link);
  await page.getByLabel("The password you chose when you scanned the card").fill(password);
  await page.getByRole("button", { name: "Confirm" }).click();
}

const CHECK_EMAIL = "Check your email";
const LINK_UNUSABLE = "This link can't be used";

test.describe("join cards", () => {
  test("a card through to a published comment", async ({ browser, publishedModeratedPost }) => {
    const { batchId, cards } = await mintTestJoinBatch({ count: 1 });
    const [card] = cards;
    const email = uniqueEmail("card-holder");
    const name = uniqueName();
    const welcome = await ensureTestWelcomePage("Glad you're here. This is the instance's welcome text.");
    const claimIp = freshIp();
    const holder = await freshPage(browser, claimIp);
    try {
      // The GET writes nothing.
      await holder.goto(`/join/${card.code}`);
      await expect(holder.getByRole("heading", { name: "Make your account" })).toBeVisible();
      expect(await getTestJoinCode(batchId, card.serial)).toMatchObject({ pendingEmail: null, confirmSends: 0 });

      // Typed in lowercase with dashes, as /join takes it: the same card.
      await holder.goto("/join");
      await holder.getByLabel("The code printed on your card").fill(
        card.code.toLowerCase().replace(/(.{4})(?!$)/g, "$1-"),
      );
      await holder.getByRole("button", { name: "Continue" }).click();
      await holder.waitForURL(`**/join/${card.code}`);

      await claim(holder, card.code, { name, email });
      await expect(holder.getByRole("heading", { name: CHECK_EMAIL })).toBeVisible();
      await expect(holder.getByText(email)).toBeVisible();
      expect(await getTestJoinCode(batchId, card.serial)).toMatchObject({
        pendingEmail: email,
        pendingName: name,
        pendingIpAddress: claimIp,
        hasPasswordHash: true,
        hasToken: true,
        confirmSends: 1,
        confirmSent: true,
        claimed: false,
      });
      // No account until the link is used.
      expect(await getTestJoinAccount(email)).toBeNull();

      const link = await setTestJoinClaimToken(batchId, card.serial);
      // The link's GET shows the form and makes nothing.
      await holder.goto(link);
      await expect(holder.getByText(email)).toBeVisible();
      expect(await getTestJoinAccount(email)).toBeNull();

      await asIp(holder, freshIp());
      await confirm(holder, link);
      await expect(holder.getByRole("heading", { name: "Your account is ready" })).toBeVisible();
      expect(await getTestJoinAccount(email)).toMatchObject({
        role: "AUTHOR",
        name,
        emailVerified: true,
        commenter: { trusted: true, displayName: name },
      });
      expect(await getTestJoinCode(batchId, card.serial)).toMatchObject({
        claimed: true,
        pendingEmail: null,
        hasPasswordHash: false,
        hasToken: false,
      });

      // Signs in with the email typed in another case, and lands on /welcome.
      await holder.getByRole("link", { name: "Sign in" }).click();
      await holder.getByLabel("Email").fill(email.toUpperCase());
      await holder.getByLabel("Password").fill(PASSWORD);
      await holder.getByRole("button", { name: "Sign in" }).click();
      await holder.waitForURL("**/welcome");
      await expect(holder.getByRole("heading", { name: `Welcome, ${name}` })).toBeVisible();
      const welcomeText = await welcomeTextFor(email);
      if (welcomeText) await expect(holder.getByText(welcomeText.slice(0, 40))).toBeVisible();
      else await expect(holder.getByText("There's no welcome page here yet.")).toBeVisible();

      // A trusted commenter: published at once under a post's ALWAYS policy.
      await asIp(holder, freshIp());
      await holder.goto(publishedModeratedPost.path);
      const body = "My first comment, from a card.";
      await holder.getByRole("textbox", { name: "Comment body" }).fill(body);
      await holder.getByRole("button", { name: "Post comment" }).click();
      await expect.poll(async () => (await getTestCommenters(email)).flatMap((row) => row.comments)).toEqual([body]);
      await expect(holder.getByText("Your comment is awaiting moderation.")).toHaveCount(0);

      // The card is spent.
      const later = await freshPage(browser);
      await later.goto(`/join/${card.code}`);
      await expect(later.getByRole("heading", { name: "This card has been used" })).toBeVisible();
      await later.context().close();
    } finally {
      await holder.context().close();
      await deleteTestUser(email);
      await deleteTestJoinBatch(batchId);
      if (welcome.created) await deleteTestDoc(welcome.docId);
    }
  });

  test("a card that can't be used, and a link that can't", async ({ browser }) => {
    const { batchId, cards } = await mintTestJoinBatch({ count: 5 });
    const [revoked, expiredLink, twice, sendsUsed, pendingAtExpiry] = cards;
    const page = await freshPage(browser);
    const emails: string[] = [];
    try {
      await setTestJoinState(batchId, { serial: revoked.serial, revoked: true });
      await page.goto(`/join/${revoked.code}`);
      await expect(page.getByRole("heading", { name: "This card can no longer be used" })).toBeVisible();

      // A code that matches no card, and one that isn't a code at all.
      await page.goto(`/join/${"0".repeat(16)}`);
      await expect(page.getByRole("heading", { name: "This card can no longer be used" })).toBeVisible();
      await page.goto("/join");
      await page.getByLabel("The code printed on your card").fill("not a code");
      await page.getByRole("button", { name: "Continue" }).click();
      await expect(page.getByText("That isn't a card's code.")).toBeVisible();

      // Five delivered sends, and the card says to ask for another.
      await setTestJoinState(batchId, { serial: sendsUsed.serial, confirmSends: 5 });
      await page.goto(`/join/${sendsUsed.code}`);
      await expect(page.getByText("This card has sent all the email it can.")).toBeVisible();

      // A link older than seven days.
      const old = uniqueEmail("card-old");
      emails.push(old);
      await claim(page, expiredLink.code, { name: uniqueName(), email: old });
      await expect(page.getByRole("heading", { name: CHECK_EMAIL })).toBeVisible();
      const oldLink = await setTestJoinClaimToken(batchId, expiredLink.serial);
      await ageTestJoinSend(batchId, expiredLink.serial, 8 * 24 * 60 * 60 * 1000);
      await page.goto(oldLink);
      await expect(page.getByRole("heading", { name: LINK_UNUSABLE })).toBeVisible();

      // A second Confirm on a used link.
      const email = uniqueEmail("card-twice");
      emails.push(email);
      await claim(page, twice.code, { name: uniqueName(), email });
      await expect(page.getByRole("heading", { name: CHECK_EMAIL })).toBeVisible();
      const link = await setTestJoinClaimToken(batchId, twice.serial);
      await confirm(page, link);
      await expect(page.getByRole("heading", { name: "Your account is ready" })).toBeVisible();
      await page.goto(link);
      await expect(page.getByRole("heading", { name: LINK_UNUSABLE })).toBeVisible();

      // An expired batch: a claim pending on it can't be confirmed, and its
      // cards say they can't be used.
      const late = uniqueEmail("card-late");
      emails.push(late);
      await claim(page, pendingAtExpiry.code, { name: uniqueName(), email: late });
      await expect(page.getByRole("heading", { name: CHECK_EMAIL })).toBeVisible();
      const lateLink = await setTestJoinClaimToken(batchId, pendingAtExpiry.serial);
      await setTestJoinState(batchId, { batchExpired: true });
      await page.goto(lateLink);
      await expect(page.getByRole("heading", { name: LINK_UNUSABLE })).toBeVisible();
      await page.goto(`/join/${pendingAtExpiry.code}`);
      await expect(page.getByRole("heading", { name: "This card can no longer be used" })).toBeVisible();
    } finally {
      await page.context().close();
      for (const email of emails) await deleteTestUser(email);
      await deleteTestJoinBatch(batchId);
    }
  });

  test("refusals at the scan and at Confirm", async ({ browser, secondUser }) => {
    const { user } = await secondUser({ role: "COMMENTER" });
    const { batchId, cards } = await mintTestJoinBatch({ count: 3 });
    const [card, wrongPw, sixth] = cards;
    const page = await freshPage(browser);
    const emails: string[] = [];
    try {
      // An email an account has, in another case: refused, and logged once.
      const ip = freshIp();
      await asIp(page, ip);
      await claim(page, card.code, { name: uniqueName(), email: user.email.toUpperCase() });
      await expect(page.getByText("An account with this email already exists")).toBeVisible();
      const card1 = await getTestJoinCode(batchId, card.serial);
      expect(card1).toMatchObject({ pendingEmail: null, confirmSends: 0 });
      expect(await getTestEmailCollisions(user.email)).toMatchObject([
        { source: "CARD_CLAIM", userId: user.id, joinCodeId: card1.id, ipAddresses: [ip], count: 1 },
      ]);

      // An email differing from that account's only at a `_` is somebody
      // else's: an `ILIKE` would read the `_` as a wildcard.
      const lookalike = user.email.replace("-second-", "-second_");
      expect(lookalike).not.toBe(user.email);
      emails.push(lookalike);
      await claim(page, card.code, { name: uniqueName(), email: lookalike });
      await expect(page.getByRole("heading", { name: CHECK_EMAIL })).toBeVisible();

      // A name an account goes by, in another case.
      await claim(page, wrongPw.code, { name: user.name!.toUpperCase(), email: uniqueEmail("card-name") });
      await expect(page.getByText("An account already goes by this name.")).toBeVisible();

      // A wrong password at Confirm counts, and the fifth ends the claim.
      const email = uniqueEmail("card-wrong");
      emails.push(email);
      await claim(page, wrongPw.code, { name: uniqueName(), email });
      await expect(page.getByRole("heading", { name: CHECK_EMAIL })).toBeVisible();
      const link = await setTestJoinClaimToken(batchId, wrongPw.serial);
      for (let left = 4; left >= 1; left--) {
        await confirm(page, link, "not-the-password");
        await expect(page.getByText(`${left} ${left === 1 ? "try" : "tries"} left`)).toBeVisible();
      }
      await confirm(page, link, "not-the-password");
      await expect(page.getByText("That was the fifth wrong password")).toBeVisible();
      expect(await getTestJoinCode(batchId, wrongPw.serial)).toMatchObject({
        pendingEmail: null,
        hasPasswordHash: false,
        hasToken: false,
        claimed: false,
      });
      expect(await getTestJoinAccount(email)).toBeNull();

      // A sixth send, once five are delivered. The minute's rule is aged past
      // between each, since a send to @example.com counts as delivered.
      for (let send = 1; send <= 5; send++) {
        const each = uniqueEmail(`card-send${send}`);
        await claim(page, sixth.code, { name: uniqueName(), email: each });
        await expect(page.getByRole("heading", { name: CHECK_EMAIL })).toBeVisible();
        if (send === 1) {
          // Within the minute: refused, and the send isn't counted.
          await claim(page, sixth.code, { name: uniqueName(), email: each });
          await expect(page.getByText("Wait a minute, then try again.")).toBeVisible();
        }
        await ageTestJoinSend(batchId, sixth.serial, 61_000);
      }
      expect(await getTestJoinCode(batchId, sixth.serial)).toMatchObject({ confirmSends: 5 });
      await page.goto(`/join/${sixth.code}`);
      await expect(page.getByText("This card has sent all the email it can.")).toBeVisible();
    } finally {
      await page.context().close();
      for (const email of emails) await deleteTestUser(email);
      await deleteTestJoinBatch(batchId);
    }
  });

  test("a signed-in viewer gets no form", async ({ page }) => {
    const { batchId, cards } = await mintTestJoinBatch({ count: 1 });
    try {
      await page.goto(`/join/${cards[0].code}`);
      await expect(page.getByRole("heading", { name: "You're signed in" })).toBeVisible();
      await expect(page.getByRole("main").getByRole("button", { name: "Sign out" })).toBeVisible();
      await expect(page.getByLabel("Choose a password")).toHaveCount(0);
    } finally {
      await deleteTestJoinBatch(batchId);
    }
  });

  test("scanning again replaces the claim, and the first link stops working", async ({ browser }) => {
    const { batchId, cards } = await mintTestJoinBatch({ count: 1 });
    const [card] = cards;
    const page = await freshPage(browser);
    const first = uniqueEmail("card-first");
    const second = uniqueEmail("card-second");
    try {
      await claim(page, card.code, { name: uniqueName(), email: first });
      await expect(page.getByRole("heading", { name: CHECK_EMAIL })).toBeVisible();
      const firstLink = await setTestJoinClaimToken(batchId, card.serial);
      await ageTestJoinSend(batchId, card.serial, 61_000);
      await claim(page, card.code, { name: uniqueName(), email: second });
      await expect(page.getByText(second)).toBeVisible();
      expect(await getTestJoinCode(batchId, card.serial)).toMatchObject({ pendingEmail: second, confirmSends: 2 });

      await page.goto(firstLink);
      await expect(page.getByRole("heading", { name: LINK_UNUSABLE })).toBeVisible();
    } finally {
      await page.context().close();
      await deleteTestUser(first);
      await deleteTestUser(second);
      await deleteTestJoinBatch(batchId);
    }
  });

  test("an anonymous identity with the email keeps its comments, and the meeting is logged", async ({
    browser,
    publishedPost,
  }) => {
    const { batchId, cards } = await mintTestJoinBatch({ count: 1 });
    const [card] = cards;
    const email = uniqueEmail("card-anon");
    const anonymousBody = "An anonymous comment from before the card.";
    const anonymous = await createComment({
      postId: publishedPost.id,
      anchoredEventId: publishedPost.eventId!,
      email,
      displayName: "Earlier Anonymous",
      body: anonymousBody,
      status: "APPROVED",
      anonymous: true,
      ipAddress: freshIp(),
    });
    const claimIp = freshIp();
    const confirmIp = freshIp();
    const page = await freshPage(browser, claimIp);
    try {
      await claim(page, card.code, { name: uniqueName(), email });
      await expect(page.getByRole("heading", { name: CHECK_EMAIL })).toBeVisible();
      const link = await setTestJoinClaimToken(batchId, card.serial);
      await asIp(page, confirmIp);
      await confirm(page, link);
      await expect(page.getByRole("heading", { name: "Your account is ready" })).toBeVisible();

      const account = (await getTestJoinAccount(email))!;
      const commenters = await getTestCommenters(email);
      expect(commenters).toHaveLength(2);
      expect(commenters.find((row) => row.userId === null)).toEqual({
        id: anonymous.commenterId,
        userId: null,
        comments: [anonymousBody],
      });
      expect(commenters.find((row) => row.userId === account.id)?.comments).toEqual([]);

      const { id: joinCodeId } = await getTestJoinCode(batchId, card.serial);
      expect(await getTestEmailCollisions(email)).toMatchObject([
        {
          source: "CARD_CONFIRM",
          count: 1,
          userId: account.id,
          commenterId: anonymous.commenterId,
          joinCodeId,
          claimIpAddress: claimIp,
          ipAddresses: [confirmIp],
        },
      ]);
    } finally {
      await page.context().close();
      await deleteTestUser(email);
      await deleteTestJoinBatch(batchId);
    }
  });

  test("the welcome page follows the wiki read rule, and its name is held", async ({ browser, secondUser }) => {
    const welcome = await ensureTestWelcomePage("Welcome text the read rule decides on.");
    test.skip(!welcome.created, "the instance has its own New Account Welcome page, which this test won't change");
    const author = await secondUser({ role: "AUTHOR" });
    const commenter = await secondUser({ role: "COMMENTER" });
    const other = await createTestWikiPage({ authorEmail: author.user.email, namespace: "commons", visibility: "SHARED" });
    try {
      // SHARED reaches an AUTHOR, as it would at the page's address…
      await author.page.goto("/welcome");
      await expect(author.page.getByText("Welcome text the read rule decides on.")).toBeVisible();
      // …and not a COMMENTER, who can't read SHARED docs. A commons page is
      // never PRIVATE (docs/WIKI.md), so this is the line the rule draws.
      await commenter.page.goto("/welcome");
      await expect(commenter.page.getByText("There's no welcome page here yet.")).toBeVisible();
      await expect(commenter.page.getByText("Welcome text the read rule decides on.")).toHaveCount(0);

      // PUBLIC reaches every account.
      expect(await writeTestWikiColumns(welcome.docId, { visibility: "PUBLIC" })).toEqual({ ok: true });
      await commenter.page.goto("/welcome");
      await expect(commenter.page.getByText("Welcome text the read rule decides on.")).toBeVisible();

      // An AUTHOR on a commons page's byline can't give it the held name.
      const renamed = await renameWikiPageAs({
        actorEmail: author.user.email,
        docId: other.id,
        change: { name: "new account welcome", variant: "mine" },
      });
      expect(renamed).toMatchObject({ ok: false });

      // Signed out, /welcome asks to sign in and comes back.
      const visitor = await freshPage(browser);
      await visitor.goto("/welcome");
      await expect(visitor).toHaveURL(/\/sign-in\?callbackUrl=%2Fwelcome$/);
      await visitor.context().close();
    } finally {
      await deleteTestDoc(other.id);
      await deleteTestDoc(welcome.docId);
    }
  });
});

test.describe("emails ignore case", () => {
  test("sign-up trims an email and refuses one in another case; sign-in and reset find it in any case", async ({
    browser,
  }) => {
    const email = uniqueEmail("case").replace("e2e-case", "e2e-Case");
    const page = await freshPage(browser);
    try {
      await page.goto("/sign-up");
      await page.getByLabel("Name").fill(uniqueName());
      await page.getByLabel("Email").fill(`  ${email}  `);
      await page.getByLabel("Password").fill(PASSWORD);
      await page.getByRole("button", { name: "Sign up" }).click();
      await page.waitForURL("**/sign-in?registered=1");
      expect(await getTestJoinAccount(email)).toMatchObject({ role: "COMMENTER" });

      await page.goto("/sign-up");
      await page.getByLabel("Email").fill(email.toLowerCase());
      await page.getByLabel("Password").fill(PASSWORD);
      await page.getByRole("button", { name: "Sign up" }).click();
      await expect(page.getByText("An account with that email already exists.")).toBeVisible();

      await page.goto("/forgot-password");
      await page.getByLabel("Email").fill(email.toUpperCase());
      await page.getByRole("button", { name: "Send reset link" }).click();
      await expect(page.getByText("If an account exists for that email")).toBeVisible();
      expect(await hasTestResetToken(email)).toBe(true);

      await page.goto("/sign-in");
      await page.getByLabel("Email").fill(email.toLowerCase());
      await page.getByLabel("Password").fill(PASSWORD);
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.waitForURL("**/dashboard");
    } finally {
      await page.context().close();
      await deleteTestUser(email);
    }
  });
});
