// /docs' Markdown import, both entry points, end to end. What each group of
// tests is pinning down — the title rule, the seeding failure the reload
// catches, and the two tests that need special handling — is in
// docs/DOC_IMPORT.md (§4, §5, §10).
import type { Page } from "@playwright/test";
import { test, expect, titleEditor, bodyEditor } from "./fixtures";
import { deleteTestDoc } from "./db";
import { E2E_TITLE_PREFIX } from "./naming";

const TITLE = `${E2E_TITLE_PREFIX}Markdown Import ${Date.now()}`;

const MARKDOWN = `# ${TITLE}

Some **bold** and *italic* text with a [link](https://example.com).

## A section

- one
- two

> a quote

\`\`\`js
const x = 1;
\`\`\`

<div>raw html</div>
`;

test("imports a markdown file into a new doc", async ({ page }) => {
  await page.goto("/docs");
  await expect(page.getByRole("button", { name: "Import Markdown" })).toBeVisible();

  await page.setInputFiles('input[type="file"][name="file"]', {
    name: "notes.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(MARKDOWN, "utf8"),
  });

  await page.waitForURL(/\/doc\/[^/]+\/edit$/, { timeout: 30_000 });

  // Slugged from the title, not left on the cuid (docs/DOC_IMPORT.md §5). The
  // trailing counter varies per run, so match the stem rather than the whole.
  expect(page.url()).toContain(`/doc/${TITLE.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);

  await expect(titleEditor(page)).toHaveText(TITLE);

  const body = bodyEditor(page);
  await expect(body.locator("h2")).toHaveText("A section");
  await expect(body.locator("strong")).toHaveText("bold");
  await expect(body.locator("em")).toHaveText("italic");
  await expect(body.locator("a")).toHaveAttribute("href", "https://example.com");
  await expect(body.locator("li")).toHaveCount(2);
  await expect(body.locator("blockquote")).toContainText("a quote");
  await expect(body.locator("pre")).toContainText("const x = 1;");
  // The leading H1 was consumed as the title, not duplicated into the body.
  await expect(body.locator("h1")).toHaveCount(0);
  // Raw HTML arrives as literal text, per markdown-import.ts's header.
  await expect(body).toContainText("<div>raw html</div>");

  // The real regression risk (docs/DOC_IMPORT.md §5): a title written only to
  // the Doc.title column is overwritten with "" on the collab server's first
  // store flush. Wait past the debounce, then reload and re-read it.
  await page.waitForTimeout(4000);
  await page.reload();
  await expect(titleEditor(page)).toHaveText(TITLE);

  await page.goto("/docs");
  await expect(page.getByRole("link", { name: TITLE })).toBeVisible();
});

// A helper for the two heading-rule cases below: import `markdown` as
// `filename` and land on the new doc's editor.
async function importMarkdown(page: Page, filename: string, markdown: string) {
  await page.goto("/docs");
  await page.setInputFiles('input[type="file"][name="file"]', {
    name: filename,
    mimeType: "text/markdown",
    buffer: Buffer.from(markdown, "utf8"),
  });
  await page.waitForURL(/\/doc\/[^/]+\/edit$/, { timeout: 30_000 });
}

test("a file that starts at ## gives up its leading H2 as the title", async ({ page }) => {
  const title = `${E2E_TITLE_PREFIX}H2 Led ${Date.now()}`;
  await importMarkdown(page, "h2-led.md", `## ${title}\n\nBody text.\n\n### A subsection\n`);

  await expect(titleEditor(page)).toHaveText(title);
  const body = bodyEditor(page);
  // Consumed, so it is not also the body's first block — while the deeper
  // heading below it is untouched.
  await expect(body.locator("h2")).toHaveCount(0);
  await expect(body.locator("h3")).toHaveText("A subsection");
  await expect(body).toContainText("Body text.");
});

test("a leading H2 stays in the body when the file also uses H1", async ({ page }) => {
  // The filename and the H2 deliberately differ: if they matched, an import
  // that wrongly consumed the H2 would produce the same title as one that
  // correctly fell back to the filename, and this would pass either way. The
  // E2E_ prefix rides on the filename because that becomes the doc title, which
  // is what the teardown sweep matches on.
  const fromFilename = `${E2E_TITLE_PREFIX}From Filename ${Date.now()}`;
  await importMarkdown(
    page,
    `${fromFilename}.md`,
    `## A preamble heading\n\nBody text.\n\n# The Real Title\n`,
  );

  await expect(titleEditor(page)).toHaveText(fromFilename);
  const body = bodyEditor(page);
  await expect(body.locator("h2")).toHaveText("A preamble heading");
  await expect(body.locator("h1")).toHaveText("The Real Title");
});

test("rejects a non-markdown file without creating a doc", async ({ page }) => {
  await page.goto("/docs");
  await page.setInputFiles('input[type="file"][name="file"]', {
    name: "notes.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("not markdown", "utf8"),
  });
  await expect(page.getByText(/isn't a Markdown file/)).toBeVisible();
  await expect(page).toHaveURL(/\/docs/);
});

// --- the paste path --------------------------------------------------------

async function openPastePanel(page: Page) {
  await page.goto("/docs");
  await page.getByRole("button", { name: "Paste Markdown" }).click();
  return page.getByRole("textbox", { name: "Markdown to import" });
}

test("pasted Markdown becomes a doc, with its leading heading as the title", async ({ page }) => {
  const title = `${E2E_TITLE_PREFIX}Pasted ${Date.now()}`;
  const box = await openPastePanel(page);
  await box.fill(`# ${title}\n\nPasted **body** text.\n\n## A section\n`);
  await page.getByRole("button", { name: "Create doc" }).click();
  await page.waitForURL(/\/doc\/[^/]+\/edit$/, { timeout: 30_000 });

  // Same heading rule as the file path — one action, one parse, one rule.
  await expect(titleEditor(page)).toHaveText(title);
  const body = bodyEditor(page);
  await expect(body.locator("strong")).toHaveText("body");
  await expect(body.locator("h2")).toHaveText("A section");
  await expect(body.locator("h1")).toHaveCount(0);
});

test("pasted Markdown with no heading leaves the doc untitled", async ({ page }) => {
  const marker = `paste-no-heading-${Date.now()}`;
  const box = await openPastePanel(page);
  await box.fill(`Just a paragraph, ${marker}.\n`);
  await page.getByRole("button", { name: "Create doc" }).click();
  await page.waitForURL(/\/doc\/[^/]+\/edit$/, { timeout: 30_000 });

  // Nothing to take a title from and no filename to fall back to, so the title
  // stays empty — the same state `+ New doc` leaves, rendered as "Untitled".
  await expect(titleEditor(page)).toHaveText("");
  await expect(bodyEditor(page)).toContainText(marker);

  // No title means no slug to derive, so this doc keeps the cuid §12n gives it
  // — which is also why the URL segment below is safe to hand to deleteTestDoc
  // as an id, where a titled doc's would be its slug.
  const docId = page.url().match(/\/doc\/([^/]+)\/edit/)![1];
  expect(docId).toMatch(/^[a-z0-9]{20,}$/);

  // Deleted here rather than left to the teardown, which finds docs by an
  // `E2E ` TITLE prefix this one deliberately hasn't got — docs/DOC_IMPORT.md §10.
  await deleteTestDoc(docId);
});

test("a paste over the size cap is refused by us, not by a 413", async ({ page }) => {
  // 800 KB: above MAX_MARKDOWN_BYTES (768 KB), below Next's own 1 MB body
  // limit. The gap between those two is the point — docs/DOC_IMPORT.md §6.
  const box = await openPastePanel(page);
  await box.fill("x".repeat(800 * 1024));
  await page.getByRole("button", { name: "Create doc" }).click();

  await expect(page.getByText(/the import limit is 768 KB/)).toBeVisible();
  await expect(page).toHaveURL(/\/docs/);
});

test("the Read clipboard button fills the box where the browser allows it", async ({ page, browserName }) => {
  // Chromium is the only engine whose clipboard-read Playwright can grant —
  // the same fact that makes the button feature-detected (docs/DOC_IMPORT.md §7).
  test.skip(browserName !== "chromium", "clipboard-read can only be granted in Chromium");

  const text = `# ${E2E_TITLE_PREFIX}From Clipboard ${Date.now()}\n\nBody.\n`;
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/docs");
  // Opening the panel first doubles as the user gesture that focuses the
  // document — writeText() on an unfocused one throws.
  await page.getByRole("button", { name: "Paste Markdown" }).click();
  await page.evaluate((value) => navigator.clipboard.writeText(value), text);
  await page.getByRole("button", { name: "Read clipboard" }).click();

  await expect(page.getByRole("textbox", { name: "Markdown to import" })).toHaveValue(text);
});
