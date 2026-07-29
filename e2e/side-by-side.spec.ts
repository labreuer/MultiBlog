// PLAN.md §14 — the side-by-side doc-link surface. This spec covers what
// nothing else does: two docs rendered in parallel columns at
// /side-by-side/<left>/<right>. Grows phase by phase alongside §14l's build
// order; Phase 2 covers just the page shell (both columns read-only, laid
// out side by side, independently identifiable) and the left===right 404.
import { test, expect } from "./fixtures";
import { ADMIN_EMAIL, createTestDoc, deleteTestDoc } from "./db";

test.describe("side-by-side page shell", () => {
  test("both docs render as independent, side-by-side columns", async ({ page }) => {
    const left = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: "Left doc body text." });
    const right = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: "Right doc body text." });

    try {
      const response = await page.goto(`/side-by-side/${left.id}/${right.id}`);
      expect(response?.status()).toBe(200);

      await expect(page.getByText(left.title)).toBeVisible();
      await expect(page.getByText(right.title)).toBeVisible();

      // Distinct accessible names — the whole point of §14f's ariaLabel prop,
      // and what keeps this page from breaking bodyEditor()'s strict-mode
      // locator elsewhere in the suite.
      const leftBody = page.getByRole("textbox", { name: "Left doc body" });
      const rightBody = page.getByRole("textbox", { name: "Right doc body" });
      await expect(leftBody).toBeVisible();
      await expect(rightBody).toBeVisible();
      await expect(leftBody).toContainText("Left doc body text.");
      await expect(rightBody).toContainText("Right doc body text.");

      // Side by side, not stacked: same row, left column left of right.
      const leftBox = await page.locator('[data-side="left"]').boundingBox();
      const rightBox = await page.locator('[data-side="right"]').boundingBox();
      expect(leftBox).not.toBeNull();
      expect(rightBox).not.toBeNull();
      expect(leftBox!.x).toBeLessThan(rightBox!.x);
      expect(Math.abs(leftBox!.y - rightBox!.y)).toBeLessThan(5);
      expect(leftBox!.height).toBeGreaterThan(0);
      expect(rightBox!.height).toBeGreaterThan(0);
    } finally {
      await page.goto("about:blank").catch(() => {});
      await deleteTestDoc(left.id);
      await deleteTestDoc(right.id);
    }
  });

  test("the same doc on both sides 404s", async ({ page }) => {
    const doc = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED" });
    try {
      const response = await page.goto(`/side-by-side/${doc.id}/${doc.id}`);
      expect(response?.status()).toBe(404);
    } finally {
      await page.goto("about:blank").catch(() => {});
      await deleteTestDoc(doc.id);
    }
  });
});
