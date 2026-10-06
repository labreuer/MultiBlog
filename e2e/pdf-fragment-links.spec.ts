import { test, expect, signIn, gotoOk } from "./fixtures";
import { ADMIN_EMAIL, TEST_PASSWORD, createTestFile, deleteTestFile, renameTestFileSlug, type TestFile } from "./db";

// docs/PDF_FRAGMENT_LINKS.md — a link to a passage that is only a URL,
// `/pdf/<slug>#page=<n>&text=<words>`. Nothing is written anywhere, so every
// assertion here is about what the viewer finds and draws on arrival: the
// outline a followed anchored link would draw, the jump, the banner, and the
// fragment surviving the two redirects a link can meet (sign-in, and a
// renamed slug).
//
// The fixture is one line per text item (scripts/make-test-pdf.ts), so a
// passage inside a line is placed within one item, which is the case the
// quads' measured spacing exists for. Page 3 ends with a folio and running
// head, so a quote across into page 4 has them between its halves.

const PAGES = [
  ["Front matter for the fragment link test."],
  [
    "The law of participation governs the earlier mind.",
    "Later the law of participation fades from view.",
    "It is a direction in which we had all better be moving,",
    "rather than a beatific consummation at the end.",
  ],
  ["A page before the break, whose last line runs on.", "It may also sometimes be detected within, but it", "3 Original Participation"],
  ["is detected primarily without, as the next page says.", "The rest of the fourth page."],
];

async function waitForViewer(page: import("@playwright/test").Page) {
  await page.waitForFunction(() => document.querySelector(".pdfViewer .page .textLayer") !== null, undefined, {
    timeout: 30_000,
  });
}

const banner = (page: import("@playwright/test").Page) => page.getByTestId("pdf-fragment-banner");
const linkRects = (page: import("@playwright/test").Page, pageNumber: number) =>
  page.locator(`.pdfViewer .page[data-page-number="${pageNumber}"] .annoRectLink`);

test.describe("pdf fragment links", () => {
  let file: TestFile;

  test.beforeAll(async () => {
    file = await createTestFile({ ownerEmail: ADMIN_EMAIL, visibility: "SHARED", pages: PAGES });
  });

  test.afterAll(async () => {
    await deleteTestFile(file.id);
  });

  async function open(page: import("@playwright/test").Page, fragment: string) {
    await signIn(page, ADMIN_EMAIL);
    await gotoOk(page, `/pdf/${file.slug}#${fragment}`);
    await waitForViewer(page);
  }

  test("a whole passage is outlined, listed in the PDF's words, and jumped to", async ({ page }) => {
    await open(page, "page=2&text=law+of+participation");

    await expect(banner(page)).toBeVisible({ timeout: 20_000 });
    await expect(banner(page)).toContainText("Linked passage");
    await expect(banner(page).getByRole("button", { name: "law of participation" })).toBeVisible();
    // One line, one outline, on the page the fragment names; and the viewer is there.
    await expect(linkRects(page, 2)).toHaveCount(1);
    await expect(page.getByLabel("Page number")).toHaveValue("2");
    // Nothing on any other page.
    await expect(page.locator(".pdfViewer .page[data-page-number='1'] .annoRectLink")).toHaveCount(0);
  });

  test("start,end runs across lines, and a prefix picks the second of two", async ({ page }) => {
    await open(
      page,
      "page=2&text=It+is+a,consummation+at+the+end&page=2&text=Later+the-,law+of+participation",
    );
    await expect(banner(page)).toContainText("Linked passages", { timeout: 20_000 });
    const rows = banner(page).getByRole("listitem");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText(
      "It is a direction in which we had all better be moving, rather than a beatific consummation at the end",
    );
    await expect(rows.nth(1)).toHaveText("law of participation");

    // The range is two lines, so two outlines; the prefixed passage is a third,
    // and it is the second line's occurrence, not the first line's.
    await expect(linkRects(page, 2)).toHaveCount(3);
    const tops = await linkRects(page, 2).evaluateAll((rects) => rects.map((rect) => rect.getBoundingClientRect().top));
    const firstLineTop = await page
      .locator(".pdfViewer .page[data-page-number='2'] .textLayer span", { hasText: "The law of participation" })
      .first()
      .evaluate((span) => span.getBoundingClientRect().top);
    const prefixedTop = tops[tops.length - 1];
    expect(prefixedTop).toBeGreaterThan(firstLineTop + 5);
  });

  test("a quote across a page break is two passages, one on each page", async ({ page }) => {
    await open(page, "page=3&text=It+may+also,within+but+it&page=4&text=is+detected+primarily+without");
    const rows = banner(page).getByRole("listitem");
    await expect(rows).toHaveCount(2, { timeout: 20_000 });
    await expect(rows.nth(0)).toHaveText("It may also sometimes be detected within, but it");
    await expect(rows.nth(1)).toHaveText("is detected primarily without");
    await expect(linkRects(page, 3)).toHaveCount(1);
    // The second passage's page may not be rendered until it is near the view.
    await rows.nth(1).getByRole("button").click();
    await expect(linkRects(page, 4)).toHaveCount(1);
  });

  test("a passage that isn't on its page says so, and the viewer still opens there", async ({ page }) => {
    await open(page, "page=2&text=words+this+page+does+not+hold");
    await expect(banner(page).getByTestId("pdf-fragment-miss")).toHaveText("Not found on page 2", { timeout: 20_000 });
    await expect(page.getByLabel("Page number")).toHaveValue("2");
    await expect(page.locator(".pdfViewer .annoRectLink")).toHaveCount(0);
  });

  test("a new fragment on an open page is found too", async ({ page }) => {
    await open(page, "page=2&text=law+of+participation");
    await expect(linkRects(page, 2)).toHaveCount(1, { timeout: 20_000 });
    await page.evaluate(() => {
      window.location.hash = "page=4&text=The+rest+of+the+fourth+page";
    });
    await expect(banner(page).getByRole("listitem")).toHaveText("The rest of the fourth page", { timeout: 20_000 });
    await expect(linkRects(page, 4)).toHaveCount(1);
    await expect(linkRects(page, 2)).toHaveCount(0);
  });

  test("the outline sits where a selection of the same words would", async ({ page }) => {
    // docs/PDF_FRAGMENT_LINKS.md §6 — the quads are computed from text items,
    // and the browser's own geometry for the same words is a Range over the
    // text layer. Horizontal edges must agree to within a couple of pixels
    // (docs/PDF.md §5: alignment at a tolerance, not overlap); vertically the
    // two boxes come from different font metrics, so they must only overlap.
    await open(page, "page=2&text=direction+in+which+we");
    await expect(linkRects(page, 2)).toHaveCount(1, { timeout: 20_000 });
    const outline = await linkRects(page, 2).first().evaluate((rect) => {
      const box = rect.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
    });
    const selection = await page.evaluate(() => {
      const layer = document.querySelector('.pdfViewer .page[data-page-number="2"] .textLayer');
      const walker = document.createTreeWalker(layer!, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = (node.textContent ?? "").indexOf("direction in which we");
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + "direction in which we".length);
        const box = range.getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
      }
      return null;
    });
    expect(selection, "the phrase is in one text-layer span").not.toBeNull();
    expect(Math.abs(outline.left - selection!.left)).toBeLessThan(2);
    expect(Math.abs(outline.right - selection!.right)).toBeLessThan(2);
    expect(outline.bottom).toBeGreaterThan(selection!.top);
    expect(outline.top).toBeLessThan(selection!.bottom);
  });

  test("a renamed file's old slug redirects with the fragment intact", async ({ page }) => {
    const oldSlug = file.slug;
    file.slug = await renameTestFileSlug(file.id);
    await signIn(page, ADMIN_EMAIL);
    await gotoOk(page, `/pdf/${oldSlug}#page=2&text=law+of+participation`);
    await page.waitForURL(`**/pdf/${file.slug}#page=2&text=law+of+participation`);
    await waitForViewer(page);
    await expect(linkRects(page, 2)).toHaveCount(1, { timeout: 20_000 });
  });

  test.describe("signed out", () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test("signing in lands on the passage, the fragment carried through", async ({ page }) => {
      await page.goto(`/pdf/${file.slug}#page=2&text=law+of+participation`);
      await page.waitForURL("**/sign-in?callbackUrl=*");
      await page.getByLabel("Email").fill(ADMIN_EMAIL);
      await page.getByLabel("Password").fill(TEST_PASSWORD);
      await page.getByRole("button", { name: "Sign in" }).click();

      await page.waitForURL(`**/pdf/${file.slug}#page=2&text=law+of+participation`);
      await waitForViewer(page);
      await expect(linkRects(page, 2)).toHaveCount(1, { timeout: 20_000 });
      await expect(banner(page)).toContainText("law of participation");
    });
  });
});
