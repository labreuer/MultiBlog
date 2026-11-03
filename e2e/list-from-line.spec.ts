// docs/TIPTAP.md "A list starts at a line break", driven in the real doc
// editor: the split and the numbering are unit-tested (list-from-line.test.ts);
// what only a browser can vouch for is where the caret lands once TipTap's
// input-rule plugin, Collaboration and the DOM selection have all had a turn.
import type { Page } from "@playwright/test";
import { test, expect, bodyEditor, waitForDocCollabReady } from "./fixtures";
import { ADMIN_EMAIL, createTestDoc, deleteTestDoc } from "./db";

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

test('"1. " on the empty line of a⏎b⏎⏎c lists that line, and what is typed next goes into the item', async ({ page }) => {
  await withDoc(page, "Seed", async () => {
    const body = bodyEditor(page);
    // Select-all is ProseMirror's own command, so the state's selection is
    // the whole doc at once; a click-then-End leaves a window in which the
    // state's caret is still where the click put it.
    await body.getByText("Seed").click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("a", { delay: 30 });
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("b", { delay: 30 });
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("c", { delay: 30 });
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.type("1. ", { delay: 60 });
    await page.keyboard.type("X", { delay: 60 });

    await expect(body.locator("ol > li")).toHaveCount(1);
    await expect(body.locator("ol > li")).toHaveText("X");
    await expect(body.locator("ol + p")).toHaveText("c");
    // a⏎b stays one paragraph above the list.
    await expect(body.locator("p:has(+ ol) br")).toHaveCount(1);
  });
});
