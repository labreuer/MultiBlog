import { test, expect, signIn, gotoOk } from "./fixtures";
import { ADMIN_EMAIL, createTestFile, deleteTestFile, type TestFile } from "./db";
import type { TestOutlineItem, TestPageLabelRange } from "../scripts/make-test-pdf";

// PLAN.md §19c — a page's *label* is what is printed on it, and it is what the
// reader can act on: three sheets of front matter mean the body's page 1 is
// sheet 4, and every other viewer, index and citation says "1".
//
// What this pins is that the two surfaces agree and that a label is *usable* —
// the box takes one back. The rule for when labels are worth showing at all is
// unit-tested (src/lib/pdf-page-labels.test.ts).

const PAGES = [
  ["Front matter, the first sheet."],
  ["Front matter, the second sheet."],
  ["Front matter, the third sheet."],
  ["The body opens here."],
  ["The body continues."],
  ["The last sheet."],
];

/** Roman front matter, then a body restarting at 1 — labels i, ii, iii, 1, 2, 3. */
const PAGE_LABELS: TestPageLabelRange[] = [
  { from: 1, style: "r" },
  { from: 4, style: "D", start: 1 },
];

const OUTLINE: TestOutlineItem[] = [
  { title: "Preface", page: 2 },
  { title: "Chapter one", page: 4 },
  { title: "Chapter two", page: 6 },
];

async function waitForViewer(page: import("@playwright/test").Page) {
  await page.waitForFunction(() => document.querySelector(".pdfViewer .page .textLayer") !== null, undefined, {
    timeout: 30_000,
  });
}

test.describe("pdf page labels", () => {
  let file: TestFile;

  test.beforeAll(async () => {
    file = await createTestFile({
      ownerEmail: ADMIN_EMAIL,
      visibility: "SHARED",
      pages: PAGES,
      outline: OUTLINE,
      pageLabels: PAGE_LABELS,
    });
  });

  test.afterAll(async () => {
    await deleteTestFile(file.id);
  });

  test("the Contents pane names pages the way the document does", async ({ page }) => {
    await signIn(page, ADMIN_EMAIL);
    await gotoOk(page, `/pdf/${file.slug}`);
    await waitForViewer(page);
    await page.getByRole("tab", { name: "Contents" }).click();

    // Sheet 2 is "ii" and sheet 4 is the body's "1" — the second is the one
    // that matters, because "4" would be a plausible, wrong-looking-right answer
    // that sends a reader to the wrong place in a printed copy.
    await expect(page.getByRole("treeitem", { name: "Preface" })).toContainText("ii");
    await expect(page.getByRole("treeitem", { name: "Chapter one" })).toContainText("1");
    await expect(page.getByRole("treeitem", { name: "Chapter two" })).toContainText("3");
  });

  test("the toolbar shows the label, and takes one back", async ({ page }) => {
    await signIn(page, ADMIN_EMAIL);
    await gotoOk(page, `/pdf/${file.slug}`);
    await waitForViewer(page);

    const box = page.getByLabel("Page number");
    await expect(box).toHaveValue("i");
    // The sheet number is what the box no longer says, so it moves to the title.
    await expect(box).toHaveAttribute("title", "Sheet 1 of 6");

    // A label typed in wins over the same text read as a sheet number: "1" is
    // the body's first page (sheet 4), not sheet 1, which is where a reader
    // copying a citation means to land.
    await box.fill("1");
    await box.press("Enter");
    // The title is what says *where* the viewer went, since the box itself
    // shows "1" either way — which is exactly the ambiguity labels create and
    // the reason the sheet number is still shown somewhere.
    await expect(box).toHaveAttribute("title", "Sheet 4 of 6");
    await expect(box).toHaveValue("1");

    // Roman numerals work the same way.
    await box.fill("iii");
    await box.press("Enter");
    await expect(box).toHaveAttribute("title", "Sheet 3 of 6");
  });

  test("clicking a Contents entry lands on that entry's page", async ({ page }) => {
    await signIn(page, ADMIN_EMAIL);
    await gotoOk(page, `/pdf/${file.slug}`);
    await waitForViewer(page);
    await page.getByRole("tab", { name: "Contents" }).click();

    // The jump is still by destination — labels are a display concern and must
    // not have crept into the navigation.
    await page.getByRole("treeitem", { name: "Chapter two" }).click();
    await expect(page.getByLabel("Page number")).toHaveValue("3");
    await expect(page.getByLabel("Page number")).toHaveAttribute("title", "Sheet 6 of 6");
  });

  test("a document whose labels are just its page numbers keeps the plain numbering", async ({ page }) => {
    // The case worth having a browser prove: plenty of files carry a
    // /PageLabels tree that reproduces 1…N. Using it would change nothing on
    // screen, so it is treated as absent — and the tell is the *title*, which
    // only appears when labels are in play.
    const plain = await createTestFile({
      ownerEmail: ADMIN_EMAIL,
      visibility: "SHARED",
      pages: PAGES.slice(0, 2),
      pageLabels: [{ from: 1, style: "D" }],
    });
    try {
      await signIn(page, ADMIN_EMAIL);
      await gotoOk(page, `/pdf/${plain.slug}`);
      await waitForViewer(page);
      await expect(page.getByLabel("Page number")).toHaveValue("1");
      await expect(page.getByLabel("Page number")).not.toHaveAttribute("title", /Sheet/);
    } finally {
      await deleteTestFile(plain.id);
    }
  });
});
