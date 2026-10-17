// src/lib/outside-mousedown.ts — a selection's popover closes on a mousedown
// outside its surface, and "outside" means outside the surface's React tree,
// not its DOM. The editor inside each composer portals its link bubble and its
// link popover to <body>, and a DOM `contains` test calls a click on either
// one outside — closing the composer, unposted, under its own Remove link.
//
// Every surface with such a popover is driven through the same two clicks —
// one into the link popover's title box, one on the bubble's Remove link —
// and then a click on bare page, which must still close it: a mark that
// outlived its event would leave a popover nothing could dismiss.
//
// The link arrives by paste, as in the report, through TipTap Link's paste
// rule. The pasted link is a plain URL rather than the report's
// "Connections.md", which links only because `.md` is a top-level domain:
// the bug is in what a click on the link's chrome does, not in what got
// linked.
import type { Locator, Page } from "@playwright/test";
import { test, expect, annotationEditor, bodyEditor, selectTextInBody, waitForDocCollabReady } from "./fixtures";
import { ADMIN_EMAIL, createTestDoc, deleteTestDoc } from "./db";

const BODY = "The quick brown fox jumps over the lazy dog.\n\nA second paragraph.";
const SELECTED = "brown fox";
const HREF = "https://example.com/notes";
const PASTED = `See ${HREF} for more.`;

// The annotation editor's toolbar is what mounts LinkControls, and so the
// bubble, and the doc editor's widget needs this width to open at all
// (ANNOTATION_WIDGET_MEDIA_QUERY).
test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
});

/** The bubble under the caret's link (LinkBubble.tsx). */
function bubble(page: Page) {
  return page.getByRole("group", { name: "Link", exact: true });
}

/**
 * A paste of plain text into a ProseMirror editor, built in the page —
 * table-sizing.spec.ts's recipe, and its note on why Playwright's own
 * dispatchEvent can't carry the clipboard and why Gecko needs the copy-over.
 */
async function pastePlainText(editor: Locator, text: string): Promise<void> {
  await editor.evaluate((el, text) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    const event = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    for (const type of dt.types) event.clipboardData?.setData(type, dt.getData(type));
    el.dispatchEvent(event);
  }, text);
}

/**
 * Pastes a link into `editor`, renames it through the link popover, then
 * unlinks it from the bubble — asserting after each portaled click that
 * `popup` is still open.
 */
async function linkThenUnlink(page: Page, popup: Locator, editor: Locator): Promise<void> {
  await editor.click();
  await pastePlainText(editor, PASTED);
  const pasted = editor.getByRole("link", { name: HREF, exact: true });
  await expect(pasted).toBeVisible();

  // The bubble's Edit link, then the link popover it opens — portaled to
  // <body> too — and a click into its title box.
  await pasted.click();
  await bubble(page).getByRole("button", { name: "Edit link" }).click();
  await expect(popup).toBeVisible();
  const titleBox = page.getByRole("textbox", { name: "Link title" });
  await expect(titleBox).toHaveValue(HREF);
  await titleBox.click();
  await expect(popup).toBeVisible();
  await titleBox.fill("the notes");
  await page.keyboard.press("Enter");
  await expect(titleBox).toHaveCount(0);
  const renamed = editor.getByRole("link", { name: "the notes", exact: true });
  await expect(renamed).toBeVisible();

  // The link bubble, portaled to <body>: Remove link — the report.
  await renamed.click();
  await bubble(page).getByRole("button", { name: "Remove link" }).click();
  await expect(editor.getByRole("link")).toHaveCount(0);
  await expect(popup).toBeVisible();
  await expect(editor).toContainText("See the notes for more.");
}

/**
 * A real mousedown on nothing in particular: the window's left edge, which
 * on every surface here is page padding beside the column. Checked first, so
 * a layout change fails here rather than landing on something that closes the
 * popover for reasons of its own (a link navigating away).
 */
async function clickBarePage(page: Page): Promise<void> {
  const x = 4;
  const y = Math.round(page.viewportSize()!.height / 2);
  const hit = await page.evaluate(
    ({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      if (!el) return "nothing";
      const active = el.closest("a, button, input, textarea, select, label, summary, [contenteditable]");
      if (active) return `an interactive <${active.tagName.toLowerCase()}>`;
      if (el.closest("[data-testid$='-popup']")) return "the popup";
      return "bare";
    },
    { x, y },
  );
  expect(hit, `the point (${x}, ${y}) should be bare page`).toBe("bare");
  await page.mouse.click(x, y);
}

test("the reading view's annotation composer stays open through clicks in its link chrome", async ({ page }) => {
  const doc = await createTestDoc({ authorEmail: ADMIN_EMAIL, bodyText: BODY });
  try {
    await page.goto(`/doc/${doc.slug}`);
    await expect(bodyEditor(page)).toBeVisible();
    // The live tap's first setContent would collapse an earlier selection
    // (DocReadingBody's note on `synced`).
    await expect(page.getByTestId("live-doc-synced")).toBeAttached({ timeout: 15_000 });
    await selectTextInBody(page, SELECTED);

    const popup = page.getByTestId("annotation-popup");
    await popup.getByRole("button", { name: "Annotate" }).click();
    await expect(annotationEditor(page)).toBeVisible();
    await popup.getByRole("button", { name: "Aa Formatting" }).click();
    await linkThenUnlink(page, popup, annotationEditor(page));

    await clickBarePage(page);
    await expect(popup).toHaveCount(0);
  } finally {
    await page.goto("about:blank").catch(() => {});
    await deleteTestDoc(doc.id);
  }
});

test("the doc editor's annotation composer stays open through clicks in its link chrome", async ({ page }) => {
  const doc = await createTestDoc({ authorEmail: ADMIN_EMAIL, bodyText: BODY });
  try {
    await page.goto(`/doc/${doc.id}/edit`);
    await waitForDocCollabReady(page);
    await selectTextInBody(page, SELECTED);
    await page.getByTestId("annotate-marker").click();

    const popup = page.getByTestId("annotation-popup");
    await expect(annotationEditor(page)).toBeVisible();
    await popup.getByRole("button", { name: "Aa Formatting" }).click();
    await linkThenUnlink(page, popup, annotationEditor(page));

    await clickBarePage(page);
    await expect(popup).toHaveCount(0);
  } finally {
    await page.goto("about:blank").catch(() => {});
    await deleteTestDoc(doc.id);
  }
});

test("the post page's comment popover stays open through clicks in its link chrome", async ({
  page,
  publishedPost,
}) => {
  await page.goto(publishedPost.path);
  // AnnotatableArticle swaps its SSR'd copy for the editor once ready;
  // selecting before that targets a copy ProseMirror isn't watching.
  await expect(bodyEditor(page)).toBeVisible();
  await selectTextInBody(page, SELECTED);

  const popup = page.getByTestId("comment-popup");
  await popup.getByRole("button", { name: "Rich text" }).click();
  await linkThenUnlink(page, popup, popup.getByRole("textbox", { name: "Comment body" }));

  await clickBarePage(page);
  await expect(popup).toHaveCount(0);
});
