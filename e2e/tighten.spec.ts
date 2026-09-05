// The toolbar's "reduce space between lines" button (EditorToolbar's
// "tighten" tool, src/lib/tighten-lines.ts) driven in the real doc editor.
// The transform's rules are unit-tested as a table (tighten-lines.test.ts);
// what only a browser can vouch for is the wiring this file covers: the
// button's enabled-ness following the live selection, the selection
// surviving a press so a second press composes, and one press being exactly
// one undo step under Collaboration's y-undo stack — the stopCapturing fence
// (docs/TIPTAP.md, "The tighten button rewrites blocks") has no unit test,
// because it only means anything against a live y-tiptap binding.
import type { Page } from "@playwright/test";
import { test, expect, bodyEditor, waitForDocCollabReady } from "./fixtures";
import { ADMIN_EMAIL, createTestDoc, deleteTestDoc } from "./db";

function tightenButton(page: Page) {
  return page.getByRole("button", { name: "Reduce space between lines" });
}

/**
 * Selects from the first occurrence of `start` to the end of the last
 * occurrence of `end` — across paragraphs, which the fixtures'
 * selectTextInBody can't do (it selects within a single text node). Same
 * discipline as its template: focus first, then set the Range, then dispatch
 * `selectionchange` so ProseMirror's selection plugin notices (the focus
 * transaction re-renders decorated text, and a Range set before the focus
 * would be silently replaced — fixtures.ts's selectTextIn comment).
 */
async function selectAcross(page: Page, start: string, end: string): Promise<void> {
  await page.evaluate(
    ({ startNeedle, endNeedle }: { startNeedle: string; endNeedle: string }) => {
      const root = document.querySelector('[aria-label="Post body"]');
      if (!root) throw new Error("Body editor not found.");
      if (root instanceof HTMLElement && root.isContentEditable) root.focus({ preventScroll: true });
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let startNode: Node | null = null;
      let startIndex = -1;
      let endNode: Node | null = null;
      let endIndex = -1;
      let node: Node | null;
      while ((node = walker.nextNode())) {
        if (!startNode) {
          const i = node.textContent?.indexOf(startNeedle) ?? -1;
          if (i !== -1) {
            startNode = node;
            startIndex = i;
          }
        }
        const j = node.textContent?.indexOf(endNeedle) ?? -1;
        if (j !== -1) {
          endNode = node;
          endIndex = j + endNeedle.length;
        }
      }
      if (!startNode || !endNode) throw new Error(`"${startNeedle}"…"${endNeedle}" not found in the body editor.`);
      const range = document.createRange();
      range.setStart(startNode, startIndex);
      range.setEnd(endNode, endIndex);
      const selection = window.getSelection();
      if (!selection) throw new Error("No selection available.");
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    },
    { startNeedle: start, endNeedle: end },
  );
}

/** A throwaway doc opened in its editor, deleted whatever happens. */
async function withDoc(page: Page, bodyText: string, fn: () => Promise<void>): Promise<void> {
  const doc = await createTestDoc({ authorEmail: ADMIN_EMAIL, bodyText });
  try {
    await page.goto(`/doc/${doc.id}/edit`);
    await waitForDocCollabReady(page);
    await fn();
  } finally {
    await page.goto("about:blank").catch(() => {});
    await deleteTestDoc(doc.id);
  }
}

test("the button follows the selection: disabled on a caret, enabled once text is selected", async ({ page }) => {
  await withDoc(page, "Only line here", async () => {
    // No selection at all, then a bare caret — inert both ways.
    await expect(tightenButton(page)).toBeDisabled();
    await bodyEditor(page).click();
    await expect(tightenButton(page)).toBeDisabled();

    await selectAcross(page, "Only", "here");
    await expect(tightenButton(page)).toBeEnabled();
  });
});

test("a run of three paragraphs collapses to one, joined by hard breaks", async ({ page }) => {
  await withDoc(page, "Alpha one\n\nBeta two\n\nGamma three", async () => {
    await selectAcross(page, "Alpha", "three");
    await tightenButton(page).click();

    const body = bodyEditor(page);
    await expect(body.locator("p")).toHaveCount(1);
    await expect(body.locator("p br")).toHaveCount(2);
    await expect(body.locator("p")).toContainText("Gamma three");
  });
});

test("an empty paragraph is removed without merging its neighbours, and the kept selection lets a second press finish", async ({
  page,
}) => {
  // "\n\n\n\n" seeds an empty paragraph between the two (docFromText).
  await withDoc(page, "First block\n\n\n\nSecond block", async () => {
    await selectAcross(page, "First", "Second block");
    await tightenButton(page).click();

    // One press, one level: the empty paragraph is gone, the neighbours are
    // adjacent but deliberately NOT merged (no hard break anywhere).
    const body = bodyEditor(page);
    await expect(body.locator("p")).toHaveCount(2);
    await expect(body.locator("p br")).toHaveCount(0);

    // No re-selecting — the press re-established the selection over the
    // affected blocks, so pressing again composes into the merge.
    await tightenButton(page).click();
    await expect(body.locator("p")).toHaveCount(1);
    await expect(body.locator("p br")).toHaveCount(1);
  });
});

test("one press is one undo step, and typing done just before it survives the undo", async ({ page }) => {
  await withDoc(page, "Keep me\n\nJoin me", async () => {
    const body = bodyEditor(page);

    // Type first: without the stopCapturing fence, y-undo's ~500ms capture
    // window would fold the press into this typing and one Ctrl+Z would
    // swallow both.
    await selectAcross(page, "Join me", "Join me");
    await page.keyboard.press("End");
    await page.keyboard.type(" please");
    await expect(body.locator("p").nth(1)).toHaveText("Join me please");

    await selectAcross(page, "Keep", "please");
    await tightenButton(page).click();
    await expect(body.locator("p")).toHaveCount(1);
    await expect(body.locator("p br")).toHaveCount(1);

    // Exactly one undo reverts the whole operation — not one boundary of it —
    // and leaves the typing alone.
    //
    // Wait for focus first. The toolbar click moves focus to the button, and
    // tightenLines' chain().focus() hands it back on the *next animation
    // frame* (@tiptap/core's focus command defers through
    // requestAnimationFrame). On a fast machine the two toHaveCount()s above
    // settle within ~30 ms of the click, so without this wait Ctrl+Z reaches
    // the button, undoes nothing, and the test fails deterministically —
    // every repeat, on a 32-thread box — while passing on slower hardware
    // where the same gap happened to be wider than a frame.
    await expect(body).toBeFocused();
    await page.keyboard.press("ControlOrMeta+z");
    await expect(body.locator("p")).toHaveCount(2);
    await expect(body.locator("p br")).toHaveCount(0);
    await expect(body.locator("p").nth(1)).toHaveText("Join me please");
  });
});
