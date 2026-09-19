// PLAN.md §24c — a CSV into an existing doc, and a table out of one. The
// three things the unit tests can't reach: the toolbar's file item and the
// drop handler put a table at the caret / drop point of a *live*
// collaborative editor, a rejection reaches the notice under the toolbar,
// and the download items (editor menu, reading-view button) hand back the
// bytes the CSV module formats — asserted as bytes, BOM and CRLF included.
import type { Page } from "@playwright/test";
import { test as base, expect, bodyEditor, waitForDocCollabReady } from "./fixtures";
import { ADMIN_EMAIL, createTestDoc, deleteTestDoc, type TestDoc } from "./db";

// Every test starts in the editor of a fresh two-paragraph doc; `auto` so
// the tests that never need the doc's slug don't have to name the fixture.
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

// A quoted comma, a doubled quote, and a quoted line break (an unquoted
// one would be a record separator — the RFC, and the parser, read it so).
const CSV = 'Name,Note\r\n"Ada, A.","says ""hi"""\r\nBob,"two\nlines"\r\n';
// What the same table formats back to: the BOM, CRLF, and quoting only
// where the RFC requires it. The two-paragraph cell comes back with a bare
// LF since that is how the grid joins paragraphs.
const ROUND_TRIP = "\uFEFF" + CSV;

async function pickTableFile(page: Page, name: string, contents: string) {
  await page.getByRole("button", { name: "Table options" }).click();
  await page.getByRole("menuitem", { name: "Table from file…" }).click();
  await page.getByLabel("Table file").setInputFiles({ name, mimeType: "text/csv", buffer: Buffer.from(contents, "utf8") });
}

async function downloadedText(page: Page, trigger: () => Promise<void>): Promise<string> {
  const waiting = page.waitForEvent("download");
  await trigger();
  const download = await waiting;
  const chunks: Buffer[] = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

test("Table from file… inserts the CSV as a table at the caret, header row first", async ({ page }) => {
  await bodyEditor(page).getByText("Paragraph two.").click();
  await pickTableFile(page, "people.csv", CSV);

  const table = bodyEditor(page).locator("table");
  await expect(table).toHaveCount(1);
  await expect(table.locator("th")).toHaveText(["Name", "Note"]);
  await expect(table.locator("td")).toHaveText(["Ada, A.", 'says "hi"', "Bob", "twolines"]);
  // The line break became a second paragraph in the cell.
  await expect(table.locator("td").nth(3).locator("p")).toHaveCount(2);
  // Both paragraphs are still there around it.
  await expect(bodyEditor(page).getByText("Paragraph one.")).toBeVisible();
  await expect(bodyEditor(page).getByText("Paragraph two.")).toBeVisible();
});

test("Download as CSV hands back the table as bytes, BOM and CRLF included", async ({ page }) => {
  await bodyEditor(page).getByText("Paragraph two.").click();
  await pickTableFile(page, "people.csv", CSV);
  await bodyEditor(page).locator("td").first().click();

  const text = await downloadedText(page, async () => {
    await page.getByRole("button", { name: "Table options" }).click();
    await page.getByRole("menuitem", { name: "Download as CSV" }).click();
  });
  expect(text).toBe(ROUND_TRIP);
});

test("a dropped CSV file lands as a table at the drop point", async ({ page }) => {
  const target = bodyEditor(page).getByText("Paragraph one.");
  const box = await target.boundingBox();
  if (!box) throw new Error("Paragraph one has no box.");
  const dataTransfer = await page.evaluateHandle((contents) => {
    const dt = new DataTransfer();
    dt.items.add(new File([contents], "dropped.csv", { type: "text/csv" }));
    return dt;
  }, CSV);
  await target.dispatchEvent("drop", { dataTransfer, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 });

  const table = bodyEditor(page).locator("table");
  await expect(table).toHaveCount(1);
  await expect(table.locator("th")).toHaveText(["Name", "Note"]);
  // Still on the doc: the browser's default for a file drop is to leave
  // for the file, and the handler claiming the event is what prevents it.
  await expect(page).toHaveURL(/\/doc\/[^/]+\/edit$/);
});

test("a malformed CSV is refused with a notice under the toolbar, and nothing is inserted", async ({ page }) => {
  await bodyEditor(page).getByText("Paragraph two.").click();
  await pickTableFile(page, "broken.csv", 'a,b\r\n"never closed,c');

  // Not getByRole("alert") alone: Next's route announcer is a permanent
  // empty role="alert" on every page.
  const notice = page.locator("p[role=alert]");
  await expect(notice).toContainText("broken.csv");
  await expect(notice).toContainText("never closed");
  await expect(bodyEditor(page).locator("table")).toHaveCount(0);

  await page.getByRole("button", { name: "Dismiss" }).click();
  await expect(notice).toHaveCount(0);
});

test("a table file can't be inserted into a table: the item is disabled inside one", async ({ page }) => {
  await bodyEditor(page).getByText("Paragraph two.").click();
  await pickTableFile(page, "people.csv", CSV);
  await bodyEditor(page).locator("td").first().click();

  await page.getByRole("button", { name: "Table options" }).click();
  await expect(page.getByRole("menuitem", { name: "Table from file…" })).toBeDisabled();
  await expect(page.getByRole("menuitem", { name: "Download as CSV" })).toBeEnabled();
  await page.keyboard.press("Escape");

  // And outside one, the reverse.
  await bodyEditor(page).getByText("Paragraph one.").click();
  await page.getByRole("button", { name: "Table options" }).click();
  await expect(page.getByRole("menuitem", { name: "Table from file…" })).toBeEnabled();
  await expect(page.getByRole("menuitem", { name: "Download as CSV" })).toBeDisabled();
});

test("the reading view offers each table as a download, from the live editor", async ({ page, tableDoc }) => {
  await bodyEditor(page).getByText("Paragraph two.").click();
  await pickTableFile(page, "people.csv", CSV);
  await expect(bodyEditor(page).locator("table")).toHaveCount(1);

  await page.goto(`/doc/${tableDoc.slug}`);
  const button = page.getByRole("button", { name: "Download table as CSV" });
  await expect(button).toBeVisible({ timeout: 30_000 });
  // Inside the table's wrapper, after the table — not an overlay.
  await expect(page.locator(".tableWrapper > button")).toHaveCount(1);

  const text = await downloadedText(page, () => button.click());
  expect(text).toBe(ROUND_TRIP);
});
