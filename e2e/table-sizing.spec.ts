// docs/TABLES.md, "Auto-size columns". A pasted table arrives frozen at its
// source's pixel widths (docs/TIPTAP.md, "A pasted table keeps its source's
// column widths"), and this is the way out. The paste is a synthetic
// ClipboardEvent carrying the text/html a word processor puts on the
// clipboard — a <colgroup> with widths — which is the one thing a unit test
// cannot do (the parse needs a DOM) and the reason this is a spec.
import { test as base, expect, bodyEditor, waitForDocCollabReady } from "./fixtures";
import { ADMIN_EMAIL, createTestDoc, deleteTestDoc, type TestDoc } from "./db";

const test = base.extend<{ tableDoc: TestDoc }>({
  tableDoc: [
    async ({ page }, use) => {
      const doc = await createTestDoc({ authorEmail: ADMIN_EMAIL, bodyText: "Paragraph one.\n\nParagraph two." });
      await page.goto(`/doc/${doc.id}/edit`);
      await waitForDocCollabReady(page);
      await use(doc);
      await page.goto("about:blank").catch(() => {});
      await deleteTestDoc(doc.id);
    },
    { auto: true },
  ],
});

// The shape Word puts on the clipboard, reduced to what the parser keeps:
// a colgroup with pixel widths (the measured 93px first column) and cells.
const PASTED_TABLE = `<table width="271"><colgroup><col width="93"><col width="178"></colgroup>
<tbody><tr><td><p>Name</p></td><td><p>Note</p></td></tr><tr><td><p>Ada</p></td><td><p>Counts</p></td></tr></tbody></table>`;

test("Auto-size columns clears a pasted table's widths and is inert on a table without any", async ({ page }) => {
  await bodyEditor(page).getByText("Paragraph two.").click();
  // Built and dispatched in the page: Playwright's dispatchEvent makes a
  // plain Event for a type it doesn't know, and "paste" is one, so a
  // clipboardData passed to it is dropped and ProseMirror sees nothing.
  await bodyEditor(page).evaluate((el, html) => {
    const dt = new DataTransfer();
    dt.setData("text/html", html);
    dt.setData("text/plain", "Name\tNote\nAda\tCounts");
    const event = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    // Chromium adopts `dt` as the event's clipboardData; Gecko ignores the
    // init member and gives the event an empty DataTransfer of its own, which
    // *is* writable — so fill whichever one the event actually carries
    // (measured 2026-09-19: getData() on the Firefox event returned "" for
    // what the constructor was handed, and the html once set on
    // event.clipboardData directly).
    for (const type of dt.types) event.clipboardData?.setData(type, dt.getData(type));
    el.dispatchEvent(event);
  }, PASTED_TABLE);

  const table = bodyEditor(page).locator("table");
  await expect(table).toHaveCount(1);
  await expect(table.locator("td")).toHaveText(["Name", "Note", "Ada", "Counts"]);

  // Frozen at the source's widths: a <col> per column with a pixel width,
  // and the table's own inline width derived from their sum.
  await expect(table.locator("col").first()).toHaveAttribute("style", /width: 93px/);
  await expect(table).toHaveAttribute("style", /width: 271px/);

  await table.locator("td").first().click();
  await page.getByRole("button", { name: "Table options" }).click();
  const item = page.getByRole("menuitem", { name: "Auto-size columns" });
  await expect(item).toBeEnabled();
  await item.click();

  // Every width gone, and with it the inline table width — the table is
  // back on prose.module.css's `width: 100%` and equal columns. Matched as
  // a leading `width:` declaration, since the node view writes a
  // `min-width` on every column and on the table once no width is set.
  const WIDTH_DECLARATION = /(^|;)\s*width:/;
  await expect
    .poll(() => table.locator("col").evaluateAll((cols) => cols.map((c) => c.getAttribute("style") ?? "")))
    .toHaveLength(2);
  const colStyles = await table.locator("col").evaluateAll((cols) => cols.map((c) => c.getAttribute("style") ?? ""));
  for (const style of colStyles) expect(style).not.toMatch(WIDTH_DECLARATION);
  expect((await table.getAttribute("style")) ?? "").not.toMatch(WIDTH_DECLARATION);
  await expect(table.locator("td")).toHaveText(["Name", "Note", "Ada", "Counts"]);

  // Nothing left to clear: the item is dry-run and reads as such.
  await page.getByRole("button", { name: "Table options" }).click();
  await expect(page.getByRole("menuitem", { name: "Auto-size columns" })).toBeDisabled();
  await page.keyboard.press("Escape");

  // A table built in the editor never had widths, so it is inert there too.
  await bodyEditor(page).getByText("Paragraph one.").click();
  await page.getByRole("button", { name: "Insert table" }).click();
  await page.getByRole("button", { name: "Table options" }).click();
  await expect(page.getByRole("menuitem", { name: "Auto-size columns" })).toBeDisabled();
});
