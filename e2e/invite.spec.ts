// Email invites (docs/EMAIL.md): an admin sends a link to an already-created
// user, that link lets them set a password and claim the account, and every
// invite ever sent stays in the audit log — several rows per user is the
// point, not an accident.
//
// sendMail is never stubbed here. Every recipient this spec creates is
// @example.com, which src/lib/mail.ts refuses to deliver to unconditionally —
// nothing leaves the box by construction, key or no key (see e2e/README.md).
import { test, expect } from "./fixtures";
import {
  ADMIN_EMAIL,
  clearColumnOrder,
  createTestInvite,
  createTestUser,
  deleteTestUser,
  getInvites,
  uniqueEmail,
} from "./db";

test.describe("email invites", () => {
  test("admin sends an invite from /users", async ({ page }) => {
    const email = uniqueEmail("invite-send");
    await createTestUser({ email, name: "Invite Send", role: "COMMENTER" });

    try {
      // ?cols= forces the two defaultHidden columns visible without going
      // through the ColumnPicker — the reliable way to assert on a
      // defaultHidden column per e2e/README.md.
      await page.goto(`/users?q=${encodeURIComponent(email)}&cols=name,email,invite,inviteUrl`);
      await expect(page.getByRole("row", { name: new RegExp(email) })).toBeVisible();

      await page.getByRole("button", { name: "Send invite" }).click();
      await page.getByRole("button", { name: "Yes" }).click();

      const inviteInput = page.locator("input[readonly]");
      await expect(inviteInput).toHaveValue(/\/invite\?token=[0-9a-f]{64}$/);

      const invites = await getInvites(email);
      expect(invites).toHaveLength(1);
      expect(invites[0].sentAt).toBeTruthy();
      expect(invites[0].clickedAt).toBeNull();
      expect(invites[0].acceptedAt).toBeNull();
      expect(invites[0].token).not.toBeNull();
    } finally {
      await deleteTestUser(email);
      // The shared admin is reused by every other spec.
      await clearColumnOrder(ADMIN_EMAIL);
    }
  });

  test("the invitee accepts and can sign in with the new password", async ({ browser }) => {
    const email = uniqueEmail("invite-accept");
    const newPassword = "a-new-password-123";
    await createTestUser({ email, name: "Invite Accept", role: "COMMENTER" });

    try {
      // Minted straight in the DB, not via the admin's "Send invite" button —
      // this test is about acceptance, and test 1 already covers the send
      // path through the real UI (e2e/README.md's "drive the UI once" rule).
      const { url } = await createTestInvite(email);

      // A fresh context, not the signed-in admin's: the invitee has no
      // session yet, and the browser pane's shared-cookie-jar trap
      // (docs/BROWSER_PANE.md) is exactly why Playwright specs use their own context
      // per identity instead.
      const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
      const invitePage = await context.newPage();

      // Navigate the invite link's path against baseURL, not the absolute URL:
      // db-worker builds it with its own appUrl(), whose APP_URL comes from
      // .env and names the dev server — the prod target (:3005) is a different
      // origin. The path+token is the part under test; the host is config.
      const inviteLink = new URL(url);
      await invitePage.goto(inviteLink.pathname + inviteLink.search);
      await expect(invitePage.getByText(email)).toBeVisible();

      await invitePage.getByLabel("Choose a password").fill(newPassword);
      await invitePage.getByRole("button", { name: "Set password" }).click();
      await expect(invitePage.getByText("Password set")).toBeVisible();

      const [invite] = await getInvites(email);
      expect(invite.acceptedAt).not.toBeNull();
      expect(invite.clickedAt).not.toBeNull();
      expect(invite.token).toBeNull();

      // The property that proves the feature is real rather than merely
      // wired: sign in with the password just set, in the same fresh context.
      await invitePage.goto("/sign-in");
      await invitePage.getByLabel("Email").fill(email);
      await invitePage.getByLabel("Password").fill(newPassword);
      await invitePage.getByRole("button", { name: "Sign in" }).click();
      await invitePage.waitForURL("**/dashboard");

      await context.close();
    } finally {
      await deleteTestUser(email);
    }
  });

  test("history is kept, and accepting one invite revokes the others", async ({ browser }) => {
    const email = uniqueEmail("invite-history");
    await createTestUser({ email, name: "Invite History", role: "COMMENTER" });

    try {
      await createTestInvite(email);
      const { url: secondUrl } = await createTestInvite(email);

      const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
      const invitePage = await context.newPage();
      // Path-relative for the same reason as the acceptance test above.
      const second = new URL(secondUrl);
      await invitePage.goto(second.pathname + second.search);
      await invitePage.getByLabel("Choose a password").fill("another-new-password-123");
      await invitePage.getByRole("button", { name: "Set password" }).click();
      await expect(invitePage.getByText("Password set")).toBeVisible();
      await context.close();

      // The property that distinguishes this table from PasswordResetToken
      // (which deletes priors on every new one): both rows still exist.
      const invites = await getInvites(email);
      expect(invites).toHaveLength(2);

      const accepted = invites.find((i) => i.acceptedAt !== null);
      const revoked = invites.find((i) => i.acceptedAt === null);
      expect(accepted).toBeTruthy();
      expect(revoked?.revokedAt).not.toBeNull();
      expect(revoked?.token).toBeNull();
    } finally {
      await deleteTestUser(email);
    }
  });
});
