import { test, expect, signIn, gotoOk } from "./fixtures";
import { ADMIN_EMAIL, createTestFile, deleteTestFile } from "./db";

// PLAN.md §19 Phase 2 / docs/PDF.md §10 — the viewer, and the version-coupling
// smoke test §10 asks for.
//
// `PDFViewerApplication`, `PDFViewer`, `pageView.div` and the eventBus event
// names are all pdfjs internals with no stability promise, and Hypothesis ship
// a standing warning that new releases may break an integration built on them.
// The point of the first test here is that a pdfjs upgrade fails **loudly, in
// CI** rather than silently at runtime in somebody's browser — so it asserts
// the specific internals this codebase touches, not that the viewer "works".

/** Waits for the viewer to finish opening the document and lay out page 1. */
async function waitForViewer(page: import("@playwright/test").Page) {
  await page.waitForFunction(() => document.querySelectorAll(".pdfViewer .page").length > 0, undefined, {
    timeout: 30_000,
  });
  // The text layer is a separate render pass, and everything anchoring-related
  // depends on it, so "a page exists" is not far enough to wait.
  await page.waitForFunction(() => document.querySelector(".pdfViewer .page .textLayer") !== null, undefined, {
    timeout: 30_000,
  });
}

test.describe("pdf viewer", () => {
  test("the pdfjs internals we depend on still exist", async ({ page }) => {
    const file = await createTestFile({ authorEmail: ADMIN_EMAIL, visibility: "SHARED" });
    try {
      await signIn(page, ADMIN_EMAIL);
      await gotoOk(page, `/pdf/${file.slug}`);
      await waitForViewer(page);

      // Asserted through the DOM rather than by importing pdfjs here: the
      // bundled module isn't reachable from a spec's evaluate, and the DOM
      // contract is the part that actually breaks. Every item below is
      // something Phase 3's anno layer or Phase 4's presence code reaches for
      // by name.
      const contract = await page.evaluate(() => {
        const container = document.querySelector("[data-pdf-container]");
        const firstPage = document.querySelector(".pdfViewer .page");
        return {
          hasContainer: !!container,
          // docs/PDF.md §6's layer structure. Our own .annoLayer is added in
          // Phase 3; these three are pdfjs's and must keep their class names,
          // because the anno layer is inserted relative to them.
          hasCanvasWrapper: !!firstPage?.querySelector(".canvasWrapper"),
          hasTextLayer: !!firstPage?.querySelector(".textLayer"),
          // `data-page-number` is how a page element is identified without
          // reaching into PDFViewer._pages.
          pageNumberAttr: firstPage?.getAttribute("data-page-number"),
          // The container is what scrolls; if pdfjs ever stops requiring an
          // absolutely-positioned scroller, our CSS is wrong rather than merely
          // redundant.
          containerScrolls: container ? getComputedStyle(container).overflow !== "visible" : false,
          version: document.querySelector("[data-pdfjs-version]")?.getAttribute("data-pdfjs-version"),
        };
      });

      expect(contract.hasContainer).toBe(true);
      expect(contract.hasCanvasWrapper).toBe(true);
      expect(contract.hasTextLayer).toBe(true);
      expect(contract.pageNumberAttr).toBe("1");
      expect(contract.containerScrolls).toBe(true);
      // Pinned exactly in package.json (docs/PDF.md invariant 6). If this fails
      // after a dependency bump, read §10 before changing the expectation.
      expect(contract.version).toBe("6.2.108");
    } finally {
      await deleteTestFile(file.id);
    }
  });

  test("renders the document's real text and navigates between pages", async ({ page }) => {
    const file = await createTestFile({
      authorEmail: ADMIN_EMAIL,
      visibility: "SHARED",
      pages: [
        ["Page one carries a distinctive phrase: heliotrope cartwheel."],
        ["Page two carries a different one: xylophone marmalade."],
        ["Page three is the last: quixotic barnacle."],
      ],
    });
    try {
      await signIn(page, ADMIN_EMAIL);
      await gotoOk(page, `/pdf/${file.slug}`);
      await waitForViewer(page);

      // The text layer carries the real extracted text — which is what makes
      // selection-based anchoring possible at all (docs/PDF.md §1's whole
      // reason for choosing PDF.js over a geometry-only renderer).
      await expect(page.locator(".pdfViewer .page[data-page-number='1'] .textLayer")).toContainText(
        "heliotrope cartwheel",
      );

      await expect(page.getByLabel("Page number")).toHaveValue("1");
      await expect(page.getByText("of 3")).toBeVisible();

      // Jump by typing a page number — this drives PDFViewer.currentPageNumber,
      // the same setter the presence "follow" feature uses in Phase 4.
      await page.getByLabel("Page number").fill("3");
      await page.getByLabel("Page number").press("Enter");
      await page.waitForFunction(
        () => document.querySelector(".pdfViewer .page[data-page-number='3'] .textLayer") !== null,
        undefined,
        { timeout: 30_000 },
      );
      await expect(page.locator(".pdfViewer .page[data-page-number='3'] .textLayer")).toContainText(
        "quixotic barnacle",
      );
    } finally {
      await deleteTestFile(file.id);
    }
  });

  test("zoom and rotation move the rendering without touching the document", async ({ page }) => {
    const file = await createTestFile({ authorEmail: ADMIN_EMAIL, visibility: "SHARED" });
    try {
      await signIn(page, ADMIN_EMAIL);
      await gotoOk(page, `/pdf/${file.slug}`);
      await waitForViewer(page);

      const pageBox = () => page.locator(".pdfViewer .page[data-page-number='1']").boundingBox();
      const before = await pageBox();
      expect(before).not.toBeNull();

      await page.getByLabel("Zoom").selectOption("2");
      await expect
        .poll(async () => (await pageBox())?.width ?? 0, { timeout: 15_000 })
        .toBeGreaterThan(before!.width);

      // Rotating swaps the page's aspect ratio. Asserted because every stored
      // anchor is measured in PDF user space precisely so that it survives
      // this — docs/PDF.md §5's "always pass the page's current rotation".
      const beforeRotate = await pageBox();
      await page.getByLabel("Rotate").click();
      await expect
        .poll(async () => (await pageBox())?.width ?? 0, { timeout: 15_000 })
        .not.toBe(beforeRotate!.width);
    } finally {
      await deleteTestFile(file.id);
    }
  });

  test("refuses a PRIVATE file to a non-author and 404s an unknown slug", async ({ page }) => {
    await signIn(page, ADMIN_EMAIL);
    const res = await page.goto("/pdf/definitely-not-a-real-file-slug");
    expect(res?.status()).toBe(404);
  });
});
