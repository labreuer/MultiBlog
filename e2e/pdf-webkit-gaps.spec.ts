import { test, expect, signIn, gotoOk } from "./fixtures";
import { ADMIN_EMAIL, createTestFile, deleteTestFile, type TestFile } from "./db";

// The built-ins pdfjs-dist needs that WebKit ships late or not at all
// (src/lib/pdfjs-webkit-polyfills.ts). Both of these were found on a real
// iPad, and both are invisible to the rest of this suite: chromium has them,
// so every other spec exercises the one engine where the bug can't happen.
//
// Simulated by *deleting* each built-in before any page script runs, rather
// than by adding a webkit project. Three reasons, in order of weight:
//
//  1. It runs in the everyday chromium suite instead of behind an opt-in flag,
//     so it actually guards the polyfill.
//  2. It pins the specific contract that broke, so a failure names the missing
//     built-in rather than "the PDF page is broken in Safari".
//  3. Playwright's webkit cannot run on this machine at all: playwright 1.62
//     ships webkit 2336, but browsers.json pins macOS 14 to a frozen 2251
//     build, whose protocol has no `PushAPIEnabled` setting — so
//     `browserContext.newPage` fails before a test body ever runs. There is a
//     `webkit` project behind E2E_WEBKIT in playwright.config.ts for machines
//     where it does work; this spec is what covers the gap where it doesn't.
//
// The limit worth knowing: this verifies the *engine gap*, not iPadOS Safari.
// The native long-press and selection-handle gestures are reproducible on a
// real device and nowhere else. It also asserts today's WebKit behaviour — if
// WebKit ever ships these, the spec keeps passing while testing a hypothetical.

const PAGE_ONE = "The quick brown fox jumps over the lazy dog on page one.";
const PHRASE = "brown fox jumps";

/** Deletes ReadableStream's async iterator, as WebKit has never implemented it. */
const DROP_STREAM_ASYNC_ITERATION = () => {
  // @ts-expect-error removing a well-known symbol method on purpose
  delete ReadableStream.prototype[Symbol.asyncIterator];
  // @ts-expect-error the .values alias goes with it
  delete ReadableStream.prototype.values;
};

/** Deletes the TC39 Map upsert methods, as older WebKit releases lack them. */
const DROP_MAP_UPSERT = () => {
  // @ts-expect-error removing a proposal method on purpose
  delete Map.prototype.getOrInsert;
  // @ts-expect-error same
  delete Map.prototype.getOrInsertComputed;
};

async function makeFile(): Promise<TestFile> {
  return createTestFile({ ownerEmail: ADMIN_EMAIL, visibility: "SHARED", pages: [[PAGE_ONE]] });
}

async function waitForViewer(page: import("@playwright/test").Page) {
  await page.waitForFunction(() => document.querySelector(".pdfViewer .page .textLayer") !== null, undefined, {
    timeout: 30_000,
  });
}

/**
 * Selects `needle` in page 1's text layer and lets the surface settle.
 *
 * No `pointerup` dispatched, deliberately: this drives the `selectionchange`
 * path, which is the only one an iPad ever reaches (PdfAnnotationSurface's
 * trigger comment). The other PDF specs dispatch pointerup and so exercise the
 * desktop path; between them both triggers are covered.
 */
async function selectViaSelectionChange(page: import("@playwright/test").Page, needle: string) {
  const found = await page.evaluate((needle) => {
    const layer = document.querySelector('.pdfViewer .page[data-page-number="1"] .textLayer');
    if (!layer) return "no text layer";
    const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const index = (node.textContent ?? "").indexOf(needle);
      if (index < 0) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + needle.length);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return "ok";
    }
    return "phrase not found in any single text node";
  }, needle);
  expect(found, `selecting "${needle}"`).toBe("ok");
}

test.describe("pdf viewer without WebKit's missing built-ins", () => {
  for (const [name, drop] of [
    ["ReadableStream async iteration", DROP_STREAM_ASYNC_ITERATION],
    ["Map upsert", DROP_MAP_UPSERT],
  ] as const) {
    test(`a selection still anchors without ${name}`, async ({ page }) => {
      await page.addInitScript(drop);

      // pdfjs failing this way rejects rather than throwing synchronously, so
      // an unhandled rejection is the symptom to catch — the surface's own
      // try/catch keeps it from being fatal, and this asserts the polyfill
      // means there is nothing to catch in the first place.
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(String(error)));

      const file = await makeFile();
      try {
        await signIn(page, ADMIN_EMAIL);
        await gotoOk(page, `/pdf/${file.slug}`);
        await waitForViewer(page);

        await selectViaSelectionChange(page, PHRASE);

        // The popover is the observable end of the whole capture path: the
        // text extraction ran, the quads resolved, and the selection was
        // published. Without the polyfill this never appears.
        await expect(page.getByRole("button", { name: "Annotate" })).toBeVisible({ timeout: 15_000 });
        await page.getByRole("button", { name: "Annotate" }).click();
        await expect(page.getByRole("blockquote").filter({ hasText: PHRASE })).toBeVisible({ timeout: 15_000 });

        expect(pageErrors, "the page should raise no errors").toEqual([]);
      } finally {
        await deleteTestFile(file.id);
      }
    });
  }
});
