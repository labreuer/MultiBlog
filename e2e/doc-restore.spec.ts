// Deleting a doc and restoring it, through both front doors: /docs' row
// action and the editor's Settings panel. Both reach setDocDeleted
// (src/app/actions/docs.ts), whose permission check has to find a row that is
// by definition soft-deleted: asked through the filtered client, it finds
// nothing and refuses every restore, for every role, as a permission failure.
//
// Each test ends by reading the doc, since a restore that reports success but
// leaves the row deleted would pass everything before that.
import { test, expect, gotoOk, visibleText, waitForDocCollabReady } from "./fixtures";
import { ADMIN_EMAIL, createTestDoc, deleteTestDoc } from "./db";

const REFUSED = /don't have permission/i;

test.describe("deleting and restoring a doc", () => {
  test("an AUTHOR restores their own PRIVATE doc from /docs, and reads it again", async ({ secondUser }) => {
    const { user, page } = await secondUser({ role: "AUTHOR" });
    const doc = await createTestDoc({ authorEmail: user.email, visibility: "PRIVATE", bodyText: "Back again." });

    try {
      // ?deleted=1 so the row stays on screen once deleted, and q so the only
      // row in the table is this test's own.
      const listing = `/docs?q=${encodeURIComponent(doc.title)}&deleted=1`;
      await gotoOk(page, listing);
      const row = page.getByRole("row").filter({ hasText: doc.title });

      await row.getByRole("button", { name: "Delete doc" }).click();
      await expect(row.getByRole("button", { name: "Restore doc" })).toBeVisible();

      // The delete landed: the reading route 404s a deleted doc.
      const deletedResponse = await page.goto(`/doc/${doc.id}`);
      expect(deletedResponse?.status()).toBe(404);

      await gotoOk(page, listing);
      await row.getByRole("button", { name: "Restore doc" }).click();
      await expect(row.getByRole("button", { name: "Delete doc" })).toBeVisible();
      await expect(page.getByText(REFUSED)).toHaveCount(0);

      await gotoOk(page, `/doc/${doc.id}`);
      await expect(visibleText(page, "Back again.")).toBeVisible();
    } finally {
      await page.goto("about:blank").catch(() => {});
      await deleteTestDoc(doc.id);
    }
  });

  test("the editor's Settings panel undeletes a doc it deleted", async ({ page }) => {
    const doc = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: "Still here." });

    try {
      await page.goto(`/doc/${doc.id}/edit`);
      await waitForDocCollabReady(page);
      await page.locator("summary", { hasText: "Settings" }).click();

      await page.getByRole("button", { name: "Delete", exact: true }).click();
      await expect(page.getByRole("button", { name: "Undelete" })).toBeVisible();

      await page.getByRole("button", { name: "Undelete" }).click();
      await expect(page.getByRole("button", { name: "Delete", exact: true })).toBeVisible();
      await expect(page.getByText(REFUSED)).toHaveCount(0);

      await gotoOk(page, `/doc/${doc.id}`);
      await expect(visibleText(page, "Still here.")).toBeVisible();
    } finally {
      await page.goto("about:blank").catch(() => {});
      await deleteTestDoc(doc.id);
    }
  });
});
