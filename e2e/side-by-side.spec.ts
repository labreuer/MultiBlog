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

// PLAN.md §14g/§14l Phase 3 — the per-column read/write toggle, exercised
// with two identities so it also proves the hoisted provider is the same
// one a live collaborator sees through, not a private copy.
test.describe("side-by-side read/write toggle", () => {
  test("toggling a column to write, typing, and toggling back leaves content correct for both identities", async ({
    page,
    secondUser,
  }) => {
    const left = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: "Left starting text." });
    const right = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: "Right starting text." });
    const { page: otherPage } = await secondUser();

    try {
      await page.goto(`/side-by-side/${left.id}/${right.id}`);
      await otherPage.goto(`/side-by-side/${left.id}/${right.id}`);

      const leftColumn = page.locator('[data-side="left"]');
      const leftBody = page.getByRole("textbox", { name: "Left doc body" });
      const otherLeftBody = otherPage.getByRole("textbox", { name: "Left doc body" });

      await expect(leftBody).toContainText("Left starting text.");

      // Toggle to write and type.
      await leftColumn.getByRole("button", { name: "Edit" }).click();
      await expect(leftColumn.locator("p", { hasText: "🟢 Live" })).toBeVisible({ timeout: 30_000 });
      await leftBody.click();
      await page.keyboard.press("End");
      await page.keyboard.type(" Edited live.");

      // The second identity, still in read mode, sees it through the same
      // provider — not a copy this column happens to hold privately.
      await expect(otherLeftBody).toContainText("Edited live.");

      // Toggle back to read — the hoisted-mode ydoc.off fix (§14g) is what
      // keeps this from leaking a setContent-on-a-destroyed-editor listener
      // on the next toggle.
      await leftColumn.getByRole("button", { name: "Doc Links" }).click();
      await expect(leftBody).toContainText("Left starting text. Edited live.");
      // Not duplicated — exactly one occurrence of the edited text.
      const bodyText = (await leftBody.textContent()) ?? "";
      expect(bodyText.match(/Edited live\./g)?.length ?? 0).toBe(1);

      // Toggle to write a second time and edit again — proves the previous
      // toggle didn't leave a stale listener that would double-apply this
      // update or throw against a torn-down editor.
      await leftColumn.getByRole("button", { name: "Edit" }).click();
      await expect(leftColumn.locator("p", { hasText: "🟢 Live" })).toBeVisible({ timeout: 30_000 });
      await leftBody.click();
      await page.keyboard.press("End");
      await page.keyboard.type(" And again.");
      await leftColumn.getByRole("button", { name: "Doc Links" }).click();
      await expect(leftBody).toContainText("Left starting text. Edited live. And again.");

      const finalText = (await leftBody.textContent()) ?? "";
      expect(finalText.match(/And again\./g)?.length ?? 0).toBe(1);

      // The right column was never touched — confirms the toggle is
      // per-column, not page-wide.
      await expect(page.getByRole("textbox", { name: "Right doc body" })).toContainText("Right starting text.");
    } finally {
      await page.goto("about:blank").catch(() => {});
      await otherPage.goto("about:blank").catch(() => {});
      await deleteTestDoc(left.id);
      await deleteTestDoc(right.id);
    }
  });
});
