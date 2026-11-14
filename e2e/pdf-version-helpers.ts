import { expect } from "./fixtures";

// What the specs of a file's versions share (docs/PDF.md §13): waiting for
// the viewer, reading which bytes a page shows, selecting a phrase as a
// reader does, and asserting an address exactly. `e2e/pdf-version-upload.spec.ts`,
// `e2e/pdf-better-copy.spec.ts` and `e2e/pdf-revised-text.spec.ts` use them.

export type Page = import("@playwright/test").Page;

/**
 * A word no other test's file holds. The store is content-addressed, so two
 * tests uploading the same lines would share one blob, and an abandoning in
 * one would count the other's row. Letters only, so a search for it is one
 * word and stems to itself.
 */
export function token(): string {
  return `q${Math.random().toString(36).slice(2, 10).replace(/[0-9]/g, "x")}${Date.now().toString(36).replace(/[0-9]/g, "z")}`;
}

export async function waitForViewer(page: Page) {
  await page.waitForFunction(() => document.querySelector(".pdfViewer .page .textLayer") !== null, undefined, {
    timeout: 30_000,
  });
}

/** The sheet's text as the viewer drew it: which bytes the page is showing. */
export async function expectSheetText(page: Page, text: string, sheet = 1) {
  await expect(page.locator(`.pdfViewer .page[data-page-number='${sheet}'] .textLayer`)).toContainText(text, { timeout: 30_000 });
}

export async function selectPhrase(page: Page, pageNumber: number, needle: string) {
  const found = await page.evaluate(
    ({ pageNumber, needle }) => {
      const layer = document.querySelector(`.pdfViewer .page[data-page-number="${pageNumber}"] .textLayer`);
      if (!layer) return "no text layer";
      const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const text = node.textContent ?? "";
        const index = text.indexOf(needle);
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
    },
    { pageNumber, needle },
  );
  expect(found, `selecting "${needle}" on page ${pageNumber}`).toBe("ok");
  await page.mouse.up();
  await page.dispatchEvent("body", "pointerup");
}

export const fragmentOf = (card: string) => card.split("#")[1];

/**
 * The address a page is on, path and fragment, exactly. A pattern anchored at
 * its end alone passes a fragment written twice, which is what a client
 * navigation that carried one leaves behind.
 */
export async function expectAddress(page: Page, address: string) {
  await expect
    .poll(
      () => {
        const url = new URL(page.url());
        return `${url.pathname}${url.hash}`;
      },
      { timeout: 30_000 },
    )
    .toBe(address);
}
