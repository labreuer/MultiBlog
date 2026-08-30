// "[[" at the caret (src/components/DocRefMenu.tsx; docs/TIPTAP.md, "`[[`
// drops a doc reference at the caret"): a menu of readable docs that
// filters as you type, and a pick that replaces the trigger and query with
// the doc's title, linked. Driven through the doc editor; the annotation
// editor mounts the same component.
import type { Page } from "@playwright/test";
import { test as base, expect, bodyEditor, waitForDocCollabReady } from "./fixtures";
import { ADMIN_EMAIL, createTestDoc, deleteTestDoc, uniqueTitle, type TestDoc } from "./db";

const test = base.extend<{ refDoc: TestDoc }>({
  refDoc: async ({ page }, use) => {
    const doc = await createTestDoc({ authorEmail: ADMIN_EMAIL, bodyText: "Paragraph one.\n\nParagraph two." });
    await page.goto(`/doc/${doc.id}/edit`);
    await waitForDocCollabReady(page);
    await use(doc);
    await page.goto("about:blank").catch(() => {});
    await deleteTestDoc(doc.id);
  },
});

function menu(page: Page) {
  return page.getByRole("listbox", { name: "Docs" });
}

/** Focuses the editor and collapses the caret to the end of the paragraph holding `needle`. */
async function caretAtEndOf(page: Page, needle: string): Promise<void> {
  await bodyEditor(page).focus();
  await page.evaluate((text) => {
    const root = document.querySelector('[aria-label="Post body"]');
    if (!root) throw new Error("Body editor not found.");
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (!node.textContent?.includes(text)) continue;
      const range = document.createRange();
      range.setStart(node, node.textContent.length);
      range.collapse(true);
      const selection = window.getSelection();
      if (!selection) throw new Error("No selection available.");
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
      return;
    }
    throw new Error(`"${text}" not found in the body editor.`);
  }, needle);
}

test.describe("[[ drops a doc reference at the caret (DocRefMenu.tsx)", () => {
  test("recent docs first, filtering as you type; Enter links the title in place, and typing on stays plain", async ({
    page,
    refDoc,
  }) => {
    void refDoc;
    const title = uniqueTitle("ref target");
    const target = await createTestDoc({ authorEmail: ADMIN_EMAIL, title, visibility: "SHARED" });
    try {
      await caretAtEndOf(page, "Paragraph one.");
      await page.keyboard.type(" see [[");
      const list = menu(page);
      await expect(list).toBeVisible();
      await expect(list).toContainText("Recently edited");

      await page.keyboard.type(title);
      const option = list.getByRole("option", { name: title });
      await expect(option).toBeVisible();
      await expect(list).not.toContainText("Recently edited");
      // The first row is highlighted without an arrow key — Enter picks it.
      await expect(option).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press("Enter");
      await expect(list).toHaveCount(0);

      // "[[" and the query are gone; the doc's title stands in their place,
      // linked to its slug.
      const link = bodyEditor(page).getByRole("link", { name: title, exact: true });
      await expect(link).toHaveAttribute("href", `/doc/${target.slug}`);
      await expect(bodyEditor(page)).toContainText(`Paragraph one. see ${title}`);
      await expect(bodyEditor(page)).not.toContainText("[[");

      // What's typed next is not part of the link (stored marks cleared on
      // pick; Link is inclusive while autolink is on).
      await page.keyboard.type(" and on.");
      await expect(bodyEditor(page)).toContainText(`${title} and on.`);
      await expect(link).toHaveText(title);
    } finally {
      await deleteTestDoc(target.id);
    }
  });

  test("a click picks from the recent list", async ({ page, refDoc }) => {
    void refDoc;
    const title = uniqueTitle("ref clicked");
    const target = await createTestDoc({ authorEmail: ADMIN_EMAIL, title, visibility: "SHARED" });
    try {
      await caretAtEndOf(page, "Paragraph two.");
      await page.keyboard.type(" [[");
      const list = menu(page);
      // Just created, so it heads the recent list.
      await list.getByRole("option", { name: title }).click();
      await expect(list).toHaveCount(0);
      const link = bodyEditor(page).getByRole("link", { name: title, exact: true });
      await expect(link).toHaveAttribute("href", `/doc/${target.slug}`);
      await expect(bodyEditor(page)).toContainText(`Paragraph two. ${title}`);
      // The click didn't take focus from the editor.
      await expect(bodyEditor(page)).toBeFocused();
    } finally {
      await deleteTestDoc(target.id);
    }
  });

  test("Escape dismisses it for that [[ only; a closed ]] never opens it", async ({ page, refDoc }) => {
    void refDoc;
    await caretAtEndOf(page, "Paragraph one.");
    await page.keyboard.type(" [[x");
    const list = menu(page);
    await expect(list).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(list).toHaveCount(0);
    // Typing on in the same context stays dismissed — and the text is
    // untouched, "[[x" and all.
    await page.keyboard.type("y");
    await expect(list).toHaveCount(0);
    await expect(bodyEditor(page)).toContainText("Paragraph one. [[xy");

    // A bracket pair already closed is not a context.
    await page.keyboard.type("]] then [[a]]");
    await expect(list).toHaveCount(0);

    // A fresh "[[" after all that opens again.
    await page.keyboard.type(" [[");
    await expect(list).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(list).toHaveCount(0);
  });

  test("ArrowDown moves the highlight; Enter then picks the highlighted row", async ({ page, refDoc }) => {
    void refDoc;
    const first = uniqueTitle("ref newer");
    const second = uniqueTitle("ref older");
    // Created older-first, so the recent list leads with `first`.
    const older = await createTestDoc({ authorEmail: ADMIN_EMAIL, title: second, visibility: "SHARED" });
    const newer = await createTestDoc({ authorEmail: ADMIN_EMAIL, title: first, visibility: "SHARED" });
    try {
      await caretAtEndOf(page, "Paragraph two.");
      await page.keyboard.type(" [[");
      const list = menu(page);
      await expect(list.getByRole("option", { name: first })).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press("ArrowDown");
      await expect(list.getByRole("option", { name: second })).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press("Enter");
      await expect(list).toHaveCount(0);
      await expect(bodyEditor(page).getByRole("link", { name: second, exact: true })).toHaveAttribute(
        "href",
        `/doc/${older.slug}`,
      );
      // Enter reached the menu, not the keymap: still one paragraph.
      await expect(bodyEditor(page).locator("p")).toHaveCount(2);
    } finally {
      await deleteTestDoc(newer.id);
      await deleteTestDoc(older.id);
    }
  });
});
