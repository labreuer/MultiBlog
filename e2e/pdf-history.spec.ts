import type { Page } from "@playwright/test";
import { test, expect, signIn, gotoOk } from "./fixtures";
import { ADMIN_EMAIL, createTestFile, deleteTestFile, type TestFile } from "./db";
import type { TestLinkItem, TestOutlineItem } from "../scripts/make-test-pdf";

// docs/PDF.md §10d — the browser history /pdf/[slug]'s viewer keeps. A link
// the document draws, a Contents entry and the page box each leave an entry,
// and Back puts the view back where the reader left it; ‹ › and a page the
// reader is already on leave none.
//
// Every entry the viewer writes is state on the page's own address, so none of
// this changes the URL: a spec that asserted on the address would pass
// whether or not anything worked. The assertions are on the view instead —
// the page box, and the container's scroll offset, to a few pixels.

const PAGES = Array.from({ length: 8 }, (_, i) => [
  `This is sheet ${i + 1} of the history fixture.`,
  i === 0 ? "Follow this line to sheet six." : `Filler for sheet ${i + 1}.`,
  i === 1 ? "Follow this line to sheet four, by name." : `More filler for sheet ${i + 1}.`,
]);

const LINKS: TestLinkItem[] = [
  { page: 1, line: 1, to: { page: 6 } },
  { page: 2, line: 2, to: { page: 4, named: "sheetFour" } },
];

const OUTLINE: TestOutlineItem[] = [
  { title: "Opening", page: 1 },
  { title: "Middle", page: 5 },
  { title: "Close", page: 7, named: "theClose" },
];

async function waitForViewer(page: Page) {
  await page.waitForFunction(() => document.querySelector(".pdfViewer .page .textLayer") !== null, undefined, {
    timeout: 30_000,
  });
}

const pageBox = (page: Page) => page.getByLabel("Page number");

/** The viewer's scroll offset: what Back is asked to restore. */
function scrollTop(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelector<HTMLElement>("[data-pdf-container]")!.scrollTop);
}

/**
 * Scrolls the viewer by `delta` pixels and waits for pdfjs to report the new
 * view: its scroll handler runs on a frame, and `updateviewarea` after it,
 * which is what the history measures the view from.
 */
async function scrollBy(page: Page, delta: number) {
  await page.evaluate(async (by) => {
    document.querySelector<HTMLElement>("[data-pdf-container]")!.scrollTop += by;
    for (let i = 0; i < 4; i += 1) await new Promise((resolve) => requestAnimationFrame(resolve));
  }, delta);
}

/** A link the document draws on a sheet: pdfjs's own `<a>` in its annotation layer. */
const documentLink = (page: Page, sheet: number) =>
  page.locator(`.page[data-page-number="${sheet}"] .annotationLayer .linkAnnotation a`).first();

async function openContents(page: Page) {
  await page.getByRole("tab", { name: "Contents" }).click();
}

/**
 * Marks the document, so a later look can tell a same-document Back from a
 * reload: Next reloads the page on a `popstate` to an entry whose state it
 * didn't write (pdf-history.ts's header), which reads exactly like Back
 * working, at the address the test expects.
 */
async function markDocument(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { __historySpec?: true }).__historySpec = true;
  });
}

async function stillTheSameDocument(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as unknown as { __historySpec?: true }).__historySpec === true);
}

/** Page-data fetches Next makes while `work` runs: a Back between two of the viewer's entries should need none. */
async function rscRequestsDuring(page: Page, work: () => Promise<void>): Promise<string[]> {
  const seen: string[] = [];
  const onRequest = (request: import("@playwright/test").Request) => {
    if (request.url().includes("_rsc=") || request.headers()["rsc"] === "1") seen.push(request.url());
  };
  page.on("request", onRequest);
  try {
    await work();
  } finally {
    page.off("request", onRequest);
  }
  return seen;
}

test.describe("pdf viewer history", () => {
  let file: TestFile;

  test.beforeAll(async () => {
    file = await createTestFile({ ownerEmail: ADMIN_EMAIL, visibility: "SHARED", pages: PAGES, links: LINKS, outline: OUTLINE });
  });

  test.afterAll(async () => {
    await deleteTestFile(file.id);
  });

  test.beforeEach(async ({ page }) => {
    await signIn(page, ADMIN_EMAIL);
    await gotoOk(page, `/pdf/${file.slug}`);
    await waitForViewer(page);
    await markDocument(page);
  });

  test("a link the document draws: Back returns to where the reader was, Forward to where it went", async ({ page }) => {
    // Off the top of the sheet, so a Back that only found the right *page*
    // would be told apart from one that found the place on it. Not so far that
    // the link leaves the view, or the click scrolls it back in first.
    await scrollBy(page, 40);
    const before = await scrollTop(page);

    await documentLink(page, 1).click();
    await expect(pageBox(page)).toHaveValue("6");
    const there = await scrollTop(page);

    const fetched = await rscRequestsDuring(page, async () => {
      await page.goBack();
      await expect.poll(() => scrollTop(page)).toBeCloseTo(before, -1);
      await expect(pageBox(page)).toHaveValue("1");

      await page.goForward();
      await expect(pageBox(page)).toHaveValue("6");
      await expect.poll(() => scrollTop(page)).toBeCloseTo(there, -1);
    });
    expect(fetched, "Back and Forward between the viewer's own entries fetch nothing").toEqual([]);
    expect(await stillTheSameDocument(page)).toBe(true);
  });

  test("a link to a named destination leaves an entry too", async ({ page }) => {
    // A load of its own, by way of another page: a `goto` that changes only
    // the fragment is a fragment navigation, whose entry the viewer leaves
    // alone (the fragment test below).
    await gotoOk(page, "/files");
    await gotoOk(page, `/pdf/${file.slug}#sheet=2`);
    await waitForViewer(page);
    await expect(pageBox(page)).toHaveValue("2");

    await documentLink(page, 2).click();
    await expect(pageBox(page)).toHaveValue("4");

    // Back to the entry the page was *opened* on by `#sheet=`, which pdfjs's
    // own history restores by a grammar that doesn't know `sheet=` (§10d).
    await page.goBack();
    await expect(pageBox(page)).toHaveValue("2");
  });

  test("a Contents entry leaves an entry, and the same entry again from where it landed doesn't", async ({ page }) => {
    await openContents(page);
    const opened = await page.evaluate(() => history.length);

    await page.getByRole("treeitem", { name: "Middle" }).click();
    await expect(pageBox(page)).toHaveValue("5");
    expect(await page.evaluate(() => history.length)).toBe(opened + 1);

    // A second click with nothing moved in between has nothing for Back to
    // undo. Counted after the next jump rather than straight after this one:
    // pdfjs pushes after an `await`, so an entry this click wrongly added
    // could still be on its way.
    await page.getByRole("treeitem", { name: "Middle" }).click();

    // By name, from there.
    await page.getByRole("treeitem", { name: "Close" }).click();
    await expect(pageBox(page)).toHaveValue("7");
    expect(await page.evaluate(() => history.length)).toBe(opened + 2);

    await page.goBack();
    await expect(pageBox(page)).toHaveValue("5");
    await page.goBack();
    await expect(pageBox(page)).toHaveValue("1");
    expect(await stillTheSameDocument(page)).toBe(true);
  });

  test("the page box leaves an entry; the step buttons and the page already shown leave none", async ({ page }) => {
    const opened = await page.evaluate(() => history.length);

    await pageBox(page).fill("5");
    await pageBox(page).press("Enter");
    await expect(pageBox(page)).toHaveValue("5");
    expect(await page.evaluate(() => history.length)).toBe(opened + 1);

    await page.getByRole("button", { name: "Next page" }).click();
    await expect(pageBox(page)).toHaveValue("6");
    expect(await page.evaluate(() => history.length)).toBe(opened + 1);

    // The box submits on blur as well as on Enter, with whatever it shows.
    await pageBox(page).fill("6");
    await pageBox(page).press("Enter");
    await pageBox(page).blur();
    expect(await page.evaluate(() => history.length)).toBe(opened + 1);

    await page.goBack();
    await expect(pageBox(page)).toHaveValue("1");
  });

  test("a fragment followed in the page keeps Back and Forward working, and never reloads the page", async ({ page }) => {
    await openContents(page);
    await page.getByRole("treeitem", { name: "Middle" }).click();
    await expect(pageBox(page)).toHaveValue("5");

    // A fragment navigation: an entry Next didn't write, whose state is null.
    await page.evaluate(() => {
      window.location.hash = "sheet=3";
    });
    await expect(pageBox(page)).toHaveValue("3");

    // A jump from that entry writes nothing to history (pdf-history.ts's
    // header), and must still move the view.
    const fromFragment = await page.evaluate(() => history.length);
    await page.getByRole("treeitem", { name: "Close" }).click();
    await expect(pageBox(page)).toHaveValue("7");
    expect(await page.evaluate(() => history.length)).toBe(fromFragment);

    // Back across the fragment to the viewer's own entry, by state.
    await page.goBack();
    await expect(pageBox(page)).toHaveValue("5");
    // Forward onto the fragment's entry: the fragment's own jump.
    await page.goForward();
    await expect(pageBox(page)).toHaveValue("3");
    await page.goBack();
    await page.goBack();
    await expect(pageBox(page)).toHaveValue("1");
    expect(await stillTheSameDocument(page)).toBe(true);
  });

  test("Back from the viewer's first entry leaves the PDF as it always did", async ({ page }) => {
    await gotoOk(page, "/files");
    await gotoOk(page, `/pdf/${file.slug}`);
    await waitForViewer(page);
    await openContents(page);

    await page.getByRole("treeitem", { name: "Middle" }).click();
    await expect(pageBox(page)).toHaveValue("5");

    await page.goBack();
    await expect(pageBox(page)).toHaveValue("1");
    await page.goBack();
    await expect(page).toHaveURL(/\/files$/);
  });
});
