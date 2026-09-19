// docs/TABLES.md — a table from a Markdown import all the way to the
// public post page: the pipe table lands in the editor, survives publish,
// renders on the static post page inside its scroll box, and is offered
// there as a download by the same button the doc view has. The TODO.md
// spec the first build owed and the post-page half of the CSV download, in one flow,
// since both need a published post whose body holds a table and
// createTestPost only takes plain text.
import type { Page } from "@playwright/test";
import { test, expect, bodyEditor, gotoOk } from "./fixtures";
import { deleteTestDoc, deleteTestPost, getPostPath } from "./db";
import { E2E_TITLE_PREFIX } from "./naming";

const TITLE = `${E2E_TITLE_PREFIX}Pipe table ${Date.now()}`;

const MARKDOWN = `# ${TITLE}

Before the table.

| Name | Note |
|---|---|
| Ada, A. | says "hi" |
| Bob | two |

After the table.
`;

// The CSV the same table formats to: the BOM, CRLF, quoting only where the
// RFC requires it (the comma and the quotes), header row as row one.
const EXPECTED_CSV = "\uFEFF" + 'Name,Note\r\n"Ada, A.","says ""hi"""\r\nBob,two\r\n';

// A pipe table can never overflow its wrapper: under `table-layout: fixed;
// width: 100%` the table is exactly the wrapper's width and prose wraps
// long words inside cells. The table that *does* overflow on a phone is a
// pasted one carrying its source's pixel widths (docs/TIPTAP.md), whose
// colgroup becomes an inline table width on the post page — so one is
// pasted in beside the imported table before publishing, 700px wide.
const WIDE_PASTE = `<table><colgroup><col width="400"><col width="300"></colgroup>
<tbody><tr><td><p>Wide</p></td><td><p>Table</p></td></tr></tbody></table>`;

async function downloadedText(page: Page, trigger: () => Promise<void>): Promise<string> {
  const waiting = page.waitForEvent("download");
  await trigger();
  const download = await waiting;
  const chunks: Buffer[] = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

test("a pipe table imports, publishes, scrolls in place on a phone, and downloads from the post page", async ({
  page,
}) => {
  await page.goto("/docs");
  await page.setInputFiles('input[type="file"][name="file"]', {
    name: "table.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(MARKDOWN, "utf8"),
  });
  await page.waitForURL(/\/doc\/[^/]+\/edit$/, { timeout: 30_000 });
  const docId = page.url().match(/\/doc\/([^/]+)\/edit$/)?.[1];
  if (!docId) throw new Error(`Couldn't read the doc id from ${page.url()}`);

  let postId: string | null = null;
  try {
    // In the editor: header cells from the header row, body cells below.
    const table = bodyEditor(page).locator("table");
    await expect(table).toHaveCount(1);
    await expect(table.locator("th")).toHaveText(["Name", "Note"]);
    await expect(table.locator("td")).toHaveText(["Ada, A.", 'says "hi"', "Bob", "two"]);

    // The wide pasted table, after the closing paragraph — dispatched in
    // the page, since Playwright's dispatchEvent drops clipboardData for
    // a "paste" (e2e/table-sizing.spec.ts).
    await bodyEditor(page).getByText("After the table.").click();
    await page.keyboard.press("End");
    await bodyEditor(page).evaluate((el, html) => {
      const dt = new DataTransfer();
      dt.setData("text/html", html);
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }, WIDE_PASTE);
    await expect(bodyEditor(page).locator("table")).toHaveCount(2);
    await expect(bodyEditor(page).locator("table").nth(1)).toHaveAttribute("style", /width: 700px/);

    // Publish it: the doc view's byline button creates the post and lands
    // on its editor; Publish there makes it public.
    await page.goto(`/doc/${docId}`);
    await page.getByRole("button", { name: "Publish as blog post" }).click();
    await page.waitForURL(/\/post\/[^/]+\/edit$/);
    postId = page.url().match(/\/post\/([^/]+)\/edit$/)?.[1] ?? null;
    if (!postId) throw new Error(`Couldn't read the post id from ${page.url()}`);
    await expect(page.getByLabel("Scrub through the doc's edit history")).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(page.getByText("Published.")).toBeVisible();

    const path = await getPostPath(postId);
    if (!path) throw new Error(`Post ${postId} has no public path after publishing.`);

    // On the post page. The article is rendered twice — the SSR'd static
    // copy, then the live editor once ready (e2e/README.md) — and both
    // draw the same wrappers, so the assertions run on the visible ones.
    await gotoOk(page, path);
    const article = page.getByRole("textbox", { name: "Post body" });
    await expect(article.locator("table").first().locator("th")).toHaveText(["Name", "Note"]);
    await expect(article.locator("table").first().locator("td")).toHaveText(["Ada, A.", 'says "hi"', "Bob", "two"]);
    await expect(article.locator("table").nth(1)).toHaveAttribute("style", /width: 700px/);

    // The download button is the doc view's component, mounted here too —
    // one per table — and the first hands back the imported table's bytes.
    const buttons = page.getByRole("button", { name: "Download table as CSV" });
    await expect(buttons).toHaveCount(2, { timeout: 15_000 });
    expect(await downloadedText(page, () => buttons.first().click())).toBe(EXPECTED_CSV);

    // At phone width the wide table's wrapper scrolls and the page does not
    // (admin-table.spec.ts's assertion, for the reading column's table).
    await page.setViewportSize({ width: 390, height: 664 });
    await expect(buttons.first()).toBeVisible();
    const m = await page.evaluate(() => {
      // The live editor's wrappers are the visible ones (the SSR'd copy is
      // display: none); the widest is the pasted table's.
      const wrap = Array.from(document.querySelectorAll<HTMLElement>(".tableWrapper"))
        .filter((el) => el.getBoundingClientRect().width > 0)
        .sort((a, b) => b.scrollWidth - a.scrollWidth)[0]!;
      return {
        innerWidth: window.innerWidth,
        mainWidth: Math.round(document.querySelector("main")!.getBoundingClientRect().width),
        overflowX: getComputedStyle(wrap).overflowX,
        clientWidth: wrap.clientWidth,
        scrollWidth: wrap.scrollWidth,
        docScrollWidth: document.documentElement.scrollWidth,
      };
    });
    expect(m.mainWidth, "main should not exceed the viewport").toBeLessThanOrEqual(m.innerWidth);
    expect(m.overflowX, "the table wrapper should scroll horizontally").toBe("auto");
    expect(m.scrollWidth, "the wide table should overflow inside its wrapper").toBeGreaterThan(m.clientWidth);
    expect(m.docScrollWidth, "the page itself must not scroll sideways").toBeLessThanOrEqual(m.innerWidth);
  } finally {
    await page.goto("about:blank").catch(() => {});
    // deleteTestPost removes the backing doc too; before the post exists
    // there is only the doc to remove.
    if (postId) await deleteTestPost(postId);
    else await deleteTestDoc(docId);
  }
});
