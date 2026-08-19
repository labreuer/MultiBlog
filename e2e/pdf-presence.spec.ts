import { test, expect, signIn, gotoOk } from "./fixtures";
import { ADMIN_EMAIL, createTestFile, deleteTestFile } from "./db";

// PLAN.md §19 Phase 4 — presence, and following.
//
// **This is the file that needs two real browser contexts**, which is why it
// can't be checked by hand in the browser pane at all: the pane's tabs share
// one cookie jar, so signing in as a second user silently converts the first
// (CLAUDE.md). Playwright's `secondUser()` fixture gives each identity its own
// context and its own jar.

/** Enough pages that "page 1" and "page 9" are unambiguously different places. */
const PAGES = Array.from({ length: 12 }, (_, i) => [`Page ${i + 1} body text, distinct marker-${i + 1}-zebra.`]);

async function waitForViewer(page: import("@playwright/test").Page) {
  await page.waitForFunction(() => document.querySelector(".pdfViewer .page .textLayer") !== null, undefined, {
    timeout: 30_000,
  });
}

async function goToPage(page: import("@playwright/test").Page, pageNumber: number) {
  await page.getByLabel("Page number").fill(String(pageNumber));
  await page.getByLabel("Page number").press("Enter");
  await page.waitForFunction(
    (n) => document.querySelector(`.pdfViewer .page[data-page-number='${n}'] .textLayer`) !== null,
    pageNumber,
    { timeout: 30_000 },
  );
}

/**
 * The follow chips in the toolbar.
 *
 * Scoped rather than matched by name alone: the left rail's dots carry the same
 * reader names in their own aria-labels ("Jump to …"), so an unscoped
 * `getByRole("button", { name: /Alice/ })` is ambiguous by construction.
 */
function followBar(page: import("@playwright/test").Page) {
  return page.locator('[aria-label="Reader presence"]');
}

/** The page number the viewer's own toolbar currently reports. */
function currentPage(page: import("@playwright/test").Page) {
  return page.getByLabel("Page number");
}

test.describe("pdf presence", () => {
  test("each reader sees where the other is, and can follow them", async ({ page, secondUser }) => {
    const file = await createTestFile({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", pages: PAGES });
    const { user, page: other } = await secondUser({ role: "AUTHOR" });

    try {
      await signIn(page, ADMIN_EMAIL);
      await gotoOk(page, `/pdf/${file.slug}`);
      await waitForViewer(page);

      await other.goto(`/pdf/${file.slug}`);
      await waitForViewer(other);

      // Each shows up in the other's follow bar. That alone proves the whole
      // transport: a token was minted, the presence ydoc was created on demand,
      // and awareness crossed the collab server.
      await expect(followBar(page).getByRole("button", { name: new RegExp(user.name!) })).toBeVisible({
        timeout: 20_000,
      });
      await expect(followBar(other).getByRole("button", { name: /E2E Admin/ })).toBeVisible({ timeout: 20_000 });

      // …and as a dot on the left rail, at a document fraction.
      await expect(page.locator('[aria-label="Other readers"] button')).toHaveCount(1, { timeout: 20_000 });

      // The admin moves to page 9; the other reader's dot for them should track
      // it. Asserted as "the dot moved down", not at an exact offset — the
      // fraction depends on page heights and rail height, and pinning it would
      // be asserting arithmetic already covered in pdf-geometry.
      const dot = other.locator('[aria-label="Other readers"] button').first();
      const before = await dot.boundingBox();
      await goToPage(page, 9);
      await expect
        .poll(async () => (await dot.boundingBox())?.y ?? 0, { timeout: 20_000 })
        .toBeGreaterThan((before?.y ?? 0) + 10);

      // Now follow: the other reader clicks the admin's chip and lands on the
      // admin's page, without being forced into the admin's zoom.
      await followBar(other).getByRole("button", { name: /E2E Admin/ }).click();
      await expect.poll(async () => currentPage(other).inputValue(), { timeout: 20_000 }).toBe("9");

      // A local scroll gesture drops the follow immediately (docs/PDF.md §9) —
      // bound to input events rather than to `scroll`, precisely so that the
      // programmatic scroll above doesn't cancel it on arrival.
      await expect(followBar(other).getByRole("button", { name: /Following E2E Admin/ })).toBeVisible();
      await other.locator("[data-pdf-container]").hover();
      await other.mouse.wheel(0, 300);
      await expect(followBar(other).getByRole("button", { name: /Following E2E Admin/ })).toHaveCount(0, {
        timeout: 20_000,
      });
    } finally {
      await deleteTestFile(file.id);
    }
  });

  test("a reader's live selection shows on the other's view", async ({ page, secondUser }) => {
    const file = await createTestFile({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", pages: PAGES });
    const { page: other } = await secondUser({ role: "AUTHOR" });

    try {
      await signIn(page, ADMIN_EMAIL);
      await gotoOk(page, `/pdf/${file.slug}`);
      await waitForViewer(page);
      await other.goto(`/pdf/${file.slug}`);
      await waitForViewer(other);

      await page.evaluate(() => {
        const layer = document.querySelector('.pdfViewer .page[data-page-number="1"] .textLayer');
        if (!layer) return;
        const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walker.nextNode())) {
          const index = (node.textContent ?? "").indexOf("marker-1-zebra");
          if (index < 0) continue;
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + "marker-1-zebra".length);
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
          return;
        }
      });
      await page.dispatchEvent("body", "pointerup");

      // Drawn into the same .annoLayer as annotation highlights, and with the
      // same filled styling — `annoRectRemote` marks what it is rather than
      // restyling it. It appears only for rendered pages, which is "show it if
      // it would be visible here" for free.
      await expect(other.locator(".annoRectRemote")).toHaveCount(1, { timeout: 20_000 });

      // And it is ephemeral: clearing the selection clears it everywhere. This
      // is the property that makes awareness the right home for it rather than
      // the ydoc (docs/PDF.md invariant 5) — nothing has to be cleaned up.
      await page.evaluate(() => window.getSelection()?.removeAllRanges());
      await page.dispatchEvent("body", "pointerup");
      await expect(other.locator(".annoRectRemote")).toHaveCount(0, { timeout: 20_000 });
    } finally {
      await deleteTestFile(file.id);
    }
  });

  test("the right-hand strip carries a clickable tick per annotation", async ({ page }) => {
    const file = await createTestFile({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", pages: PAGES });
    try {
      await signIn(page, ADMIN_EMAIL);
      await gotoOk(page, `/pdf/${file.slug}`);
      await waitForViewer(page);

      const strip = page.locator('[aria-label="Document map"]');
      await expect(strip).toBeVisible();
      await expect(strip.getByRole("button")).toHaveCount(0);

      // Annotate something near the *end* of the document, so the tick's
      // position is unambiguous and the jump is a real move.
      await goToPage(page, 10);
      await page.evaluate(() => {
        const layer = document.querySelector('.pdfViewer .page[data-page-number="10"] .textLayer');
        if (!layer) return;
        const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walker.nextNode())) {
          const index = (node.textContent ?? "").indexOf("marker-10-zebra");
          if (index < 0) continue;
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + "marker-10-zebra".length);
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
          return;
        }
      });
      await page.dispatchEvent("body", "pointerup");
      await page.getByRole("button", { name: "Annotate" }).click();
      // Capturing a selection auto-opens the editor — there is no placeholder
      // to click. See e2e/pdf-annotations.spec.ts for the test that pins it.
      const editor = page.getByRole("textbox", { name: "Annotation body" });
      await editor.click();
      await editor.pressSequentially("Near the end.");
      await page.getByRole("button", { name: "Post annotation" }).click();
      await expect(page.getByRole("button", { name: "Write an annotation..." })).toBeVisible({ timeout: 15_000 });

      // One tick, in the lower part of the strip because the annotation is on
      // page 10 of 12 — asserted as a fraction of the strip's own height rather
      // than at a pixel, since the exact offset is page-height arithmetic that
      // pdf-geometry already owns.
      const tick = strip.getByRole("button").first();
      await expect(tick).toBeVisible({ timeout: 20_000 });
      const stripBox = await strip.boundingBox();
      const tickBox = await tick.boundingBox();
      expect(stripBox && tickBox).toBeTruthy();
      const fraction = (tickBox!.y - stripBox!.y) / stripBox!.height;
      expect(fraction).toBeGreaterThan(0.6);

      // Clicking it jumps back to that passage from wherever the reader is.
      await goToPage(page, 1);
      await tick.click();
      await expect.poll(async () => currentPage(page).inputValue(), { timeout: 20_000 }).not.toBe("1");
    } finally {
      await deleteTestFile(file.id);
    }
  });
});
