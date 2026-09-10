import { test, expect, signIn, gotoOk } from "./fixtures";
import { ADMIN_EMAIL, createTestFile, deleteTestFile, type TestFile } from "./db";
import type { TestOutlineItem } from "../scripts/make-test-pdf";

// PLAN.md §19b — /pdf/[slug]'s Contents pane.
//
// Three things here are not observable anywhere but in a browser, and each is a
// wrong answer that would look plausible:
//
//  1. a click on an entry moves the viewer to *that* entry's page;
//  2. scrolling the document moves the highlight, and lands on the entry the
//     reader is inside rather than the next one down;
//  3. collapsing a subtree hands the highlight to the ancestor — which is the
//     whole reason the pane tracks the position at all.
//
// The destination arithmetic underneath is unit-tested (src/lib/pdf-outline.test.ts);
// nothing here re-checks it.

/** Six pages, so a section can be scrolled past without reaching the next one. */
const PAGES = [
  ["Front matter, page one."],
  ["Chapter one opens here on page two."],
  ["Section 1.1 continues on page three."],
  ["Section 1.2 begins on page four."],
  ["Chapter two opens on page five."],
  ["Section 2.1 is the tail of the document."],
];

/**
 * The fixture's outline. Two shapes on purpose beyond the plain nesting:
 * "Section 1.2" is reached through a **named** destination rather than an
 * inline array, and "Chapter two" ships **closed** (a negative /Count), which is
 * what the default-expansion rule reads.
 */
const OUTLINE: TestOutlineItem[] = [
  { title: "Front matter", page: 1 },
  {
    title: "Chapter one",
    page: 2,
    children: [
      { title: "Section 1.1", page: 3 },
      { title: "Section 1.2", page: 4, named: "sectionOneTwo" },
    ],
  },
  {
    title: "Chapter two",
    page: 5,
    open: false,
    children: [{ title: "Section 2.1", page: 6 }],
  },
];

async function waitForViewer(page: import("@playwright/test").Page) {
  await page.waitForFunction(() => document.querySelector(".pdfViewer .page .textLayer") !== null, undefined, {
    timeout: 30_000,
  });
}

/** The Contents pane, opened. The side panel starts on Annotations. */
async function openContents(page: import("@playwright/test").Page) {
  await page.getByRole("tab", { name: "Contents" }).click();
  return page.getByRole("tree", { name: "Table of contents" });
}

const row = (page: import("@playwright/test").Page, name: string) =>
  page.getByRole("treeitem", { name, exact: false });

/** Which row is the reader's current location, by its accessible name. */
async function currentRow(page: import("@playwright/test").Page): Promise<string | null> {
  return page.evaluate(() => {
    const el = document.querySelector('[role="treeitem"][aria-current="location"]');
    return el?.textContent?.replace(/[▸▾]/g, "").trim() ?? null;
  });
}

/**
 * Scrolls the viewer so a page's top edge is at the top of the viewport.
 *
 * **Not the page-number box**, which would be testing the toolbar rather than
 * the thing these tests are about. (It used to be unusable here as well: the
 * viewer's own readout overwrote typed digits while a scroll settled. That is
 * fixed — PdfViewer's `editingPageRef` — and `e2e/pdf-page-labels.spec.ts`
 * covers typing into it.)
 *
 * Every page has a div even before pdfjs renders it (it virtualises the canvas
 * and text layers, not the boxes), so this works for a page far off screen.
 */
async function scrollToPage(page: import("@playwright/test").Page, pageNumber: number) {
  const moved = await page.evaluate((n) => {
    const container = document.querySelector<HTMLElement>("[data-pdf-container]");
    const target = container?.querySelector<HTMLElement>(`.page[data-page-number="${n}"]`);
    if (!container || !target) return false;
    // Measured rather than read off `offsetTop`, which is relative to whichever
    // ancestor happens to be positioned.
    container.scrollTop += target.getBoundingClientRect().top - container.getBoundingClientRect().top;
    return true;
  }, pageNumber);
  expect(moved, `scrolling to page ${pageNumber}`).toBe(true);
}

test.describe("pdf contents pane", () => {
  let file: TestFile;

  test.beforeAll(async () => {
    file = await createTestFile({
      ownerEmail: ADMIN_EMAIL,
      visibility: "SHARED",
      pages: PAGES,
      outline: OUTLINE,
    });
  });

  test.afterAll(async () => {
    await deleteTestFile(file.id);
  });

  test("the outline renders as a tree, honouring the document's own open/closed hints", async ({ page }) => {
    await signIn(page, ADMIN_EMAIL);
    await gotoOk(page, `/pdf/${file.slug}`);
    await waitForViewer(page);
    const tree = await openContents(page);

    await expect(tree).toBeVisible();
    // Chapter one ships open, so its sections are rendered…
    await expect(row(page, "Section 1.1")).toBeVisible();
    // …and Chapter two ships closed (a negative /Count), so its section is not
    // in the DOM at all. Hidden rows aren't hidden with CSS — they aren't
    // rendered — which is what keeps a 500-entry outline cheap.
    await expect(row(page, "Section 2.1")).toHaveCount(0);
    await expect(row(page, "Chapter two")).toHaveAttribute("aria-expanded", "false");

    // Depth is carried by aria-level, since the tree renders flat.
    await expect(row(page, "Chapter one")).toHaveAttribute("aria-level", "1");
    await expect(row(page, "Section 1.1")).toHaveAttribute("aria-level", "2");

    // The page number beside each entry is the resolved destination, which is
    // the only visible proof that a **named** destination resolved at all:
    // Section 1.2 is reached by name, not by an inline array.
    await expect(row(page, "Section 1.2")).toContainText("4");
  });

  test("expanding and collapsing shows and hides a subtree", async ({ page }) => {
    await signIn(page, ADMIN_EMAIL);
    await gotoOk(page, `/pdf/${file.slug}`);
    await waitForViewer(page);
    await openContents(page);

    // The twisty is not a button — a treeitem may not contain interactive
    // descendants — so this is a click on the glyph, and the assertion is that
    // it opens the subtree *without* also jumping (the row's own click does).
    await row(page, "Chapter two").locator("span").first().click();
    await expect(row(page, "Section 2.1")).toBeVisible();
    await expect(row(page, "Chapter two")).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByLabel("Page number")).toHaveValue("1");

    await row(page, "Chapter two").locator("span").first().click();
    await expect(row(page, "Section 2.1")).toHaveCount(0);
  });

  test("clicking an entry moves the viewer to it", async ({ page }) => {
    await signIn(page, ADMIN_EMAIL);
    await gotoOk(page, `/pdf/${file.slug}`);
    await waitForViewer(page);
    await openContents(page);

    await row(page, "Section 1.1").click();
    await expect(page.getByLabel("Page number")).toHaveValue("3");

    // The named destination takes the same path through pdfjs's link service,
    // and is the arm that would fail silently if the name never resolved.
    await row(page, "Section 1.2").click();
    await expect(page.getByLabel("Page number")).toHaveValue("4");
  });

  test("scrolling the document moves the highlight", async ({ page }) => {
    await signIn(page, ADMIN_EMAIL);
    await gotoOk(page, `/pdf/${file.slug}`);
    await waitForViewer(page);
    await openContents(page);

    // Page one: the front matter.
    await expect.poll(() => currentRow(page)).toContain("Front matter");

    await scrollToPage(page, 3);
    await expect.poll(() => currentRow(page)).toContain("Section 1.1");

    // Page five is Chapter two's own page — and its section, on page six,
    // has not been reached, so the chapter is what's current. (The "last
    // entry at or above the reading line" rule; the next entry down winning
    // here would be the plausible wrong answer.)
    await scrollToPage(page, 5);
    await expect.poll(() => currentRow(page)).toContain("Chapter two");
  });

  test("a collapsed subtree takes the highlight of the entry inside it", async ({ page }) => {
    await signIn(page, ADMIN_EMAIL);
    await gotoOk(page, `/pdf/${file.slug}`);
    await waitForViewer(page);
    await openContents(page);

    // Open Chapter two and read its section: the section is what's current.
    await row(page, "Chapter two").locator("span").first().click();
    await scrollToPage(page, 6);
    await expect.poll(() => currentRow(page)).toContain("Section 2.1");

    // Collapse it again without moving the document. The reader is still in
    // Section 2.1 — but it isn't on screen, so the chapter carries the mark.
    await row(page, "Chapter two").locator("span").first().click();
    await expect.poll(() => currentRow(page)).toContain("Chapter two");
    await expect(row(page, "Chapter two")).toHaveAttribute("aria-current", "location");
  });

  test("the arrow keys move through the tree and open a subtree", async ({ page }) => {
    await signIn(page, ADMIN_EMAIL);
    await gotoOk(page, `/pdf/${file.slug}`);
    await waitForViewer(page);
    await openContents(page);

    await row(page, "Front matter").focus();
    await page.keyboard.press("ArrowDown");
    await expect(row(page, "Chapter one")).toBeFocused();

    // Right on a closed row opens it; the second press steps into it.
    await page.keyboard.press("End");
    await expect(row(page, "Chapter two")).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(row(page, "Chapter two")).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("ArrowRight");
    await expect(row(page, "Section 2.1")).toBeFocused();

    // Left on a leaf goes to the parent; Enter jumps.
    await page.keyboard.press("ArrowLeft");
    await expect(row(page, "Chapter two")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("Page number")).toHaveValue("5");
  });

  test("the tab strip fits the panel it lives in", async ({ page }) => {
    await signIn(page, ADMIN_EMAIL);
    await gotoOk(page, `/pdf/${file.slug}`);
    await waitForViewer(page);

    // A fourth tab is what made this worth asserting: the strip is a nowrap
    // flex row inside a panel that narrows to 260px, so an overflow here would
    // clip a tab silently rather than wrapping or scrolling.
    const overflow = await page.evaluate(() => {
      const strip = document.querySelector<HTMLElement>('[role="tablist"][aria-label="Side panel"]');
      return strip ? strip.scrollWidth - strip.clientWidth : -1;
    });
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("a PDF with no outline says so", async ({ page }) => {
    const plain = await createTestFile({ ownerEmail: ADMIN_EMAIL, visibility: "SHARED" });
    try {
      await signIn(page, ADMIN_EMAIL);
      await gotoOk(page, `/pdf/${plain.slug}`);
      await waitForViewer(page);
      await page.getByRole("tab", { name: "Contents" }).click();
      await expect(page.getByText("This PDF has no table of contents.")).toBeVisible();
    } finally {
      await deleteTestFile(plain.id);
    }
  });
});
