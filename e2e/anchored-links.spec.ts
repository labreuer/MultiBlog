import { test, expect, signIn, gotoOk, selectTextInBody, bodyEditor, QUOTED_TEXT, QUOTE_FROM, QUOTE_TO } from "./fixtures";
import {
  ADMIN_EMAIL,
  createTestAnchoredLink,
  createTestDoc,
  createTestFile,
  deleteTestAnchoredLink,
  deleteTestDoc,
  deleteTestFile,
  type TestFile,
} from "./db";

// docs/ANCHORED_LINKS.md Increment 8 — anchored links: one shareable URL
// over selections gathered across a doc and a PDF.
//
// The load-bearing assertions are the two ends of the feature's contract:
// the *same draft* is still in the tray after navigating between surfaces
// (the server row is the persistence — there is no client-side part bank),
// and a minted URL renders each target group only for viewers who may read
// that target, with an unreadable group acknowledged nowhere (the
// per-target filter, PERMISSIONS.md's recorded deviation from §20i).
//
// Link rows are created through the real UI as the shared admin; the
// teardown's deleteTestUser sweep deletes them with their creator
// (anchored_link.created_by_id is RESTRICT, the doc-link shape).

const PAGE_ONE = "The quick brown fox jumps over the lazy dog on page one.";
const PAGE_TWO = "A distinctive phrase for page two: xylophone marmalade.";
const PDF_PHRASE = "brown fox jumps";

// The nav test's second doc — a single paragraph, so character index `i`
// sits at ProseMirror position `i + 1` (the QUOTED_BODY convention,
// e2e/fixtures.ts).
const NAV_DOC_B_BODY = "Filters, sort and pagination live in the querystring and are applied in Postgres.";
const NAV_B_QUOTE = "applied in Postgres";
const NAV_B_FROM = NAV_DOC_B_BODY.indexOf(NAV_B_QUOTE) + 1;
const NAV_B_TO = NAV_B_FROM + NAV_B_QUOTE.length;

async function makeFile(): Promise<TestFile> {
  return createTestFile({
    ownerEmail: ADMIN_EMAIL,
    visibility: "SHARED",
    pages: [[PAGE_ONE], [PAGE_TWO]],
  });
}

async function waitForViewer(page: import("@playwright/test").Page) {
  await page.waitForFunction(() => document.querySelector(".pdfViewer .page .textLayer") !== null, undefined, {
    timeout: 30_000,
  });
}

/** pdf-annotations.spec.ts's selection recipe — a real Range plus pointerup. */
async function selectPhrase(page: import("@playwright/test").Page, pageNumber: number, needle: string) {
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

/** Adds the current doc reading-view selection to the draft link. */
async function addDocSelectionToLink(page: import("@playwright/test").Page, needle: string) {
  await selectTextInBody(page, needle);
  const popup = page.getByTestId("annotation-popup");
  await expect(popup).toBeVisible();
  await popup.getByRole("button", { name: "Add to link" }).click();
}

/**
 * Mints the draft and returns the copied URL. Clipboard read needs the
 * permission granted on the context before this runs.
 */
async function copyMintedLink(page: import("@playwright/test").Page): Promise<URL> {
  const tray = page.getByTestId("anchored-link-tray");
  await tray.getByRole("button", { name: "Copy link" }).click();
  await expect(tray).toContainText("Recipients see only the passages they have permission to read", {
    timeout: 15_000,
  });
  const url = await page.evaluate(() => navigator.clipboard.readText());
  expect(url, "the minted URL landed on the clipboard").toContain("?sel=");
  return new URL(url);
}

test.describe("anchored links", () => {
  test("a draft gathers parts across surfaces, and the minted URL follows back", async ({ page, sharedDoc }) => {
    const file = await makeFile();
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    try {
      await signIn(page, ADMIN_EMAIL);

      // Part 1: a doc passage, from the reading view's selection popover.
      await gotoOk(page, `/doc/${sharedDoc.slug}`);
      await expect(bodyEditor(page)).toBeVisible();
      await expect(page.getByTestId("live-doc-synced")).toBeAttached({ timeout: 15_000 });
      await addDocSelectionToLink(page, QUOTED_TEXT);

      const tray = page.getByTestId("anchored-link-tray");
      await expect(tray).toBeVisible({ timeout: 15_000 });
      await expect(tray).toContainText("1 passage");
      await expect(tray).toContainText(QUOTED_TEXT);

      // Part 2: a PDF passage — and the tray still holds part 1, which is
      // the cross-page persistence claim (the server row IS the draft).
      await gotoOk(page, `/pdf/${file.slug}`);
      await waitForViewer(page);
      await selectPhrase(page, 1, PDF_PHRASE);
      await page.getByRole("button", { name: "Add to link" }).click();
      await expect(tray).toContainText("2 passages", { timeout: 15_000 });

      const url = await copyMintedLink(page);
      // Part 0 is the doc part, and doc hrefs are minted by id (docs have no
      // slug history), so the landing page is /doc/<id>.
      expect(url.pathname).toBe(`/doc/${sharedDoc.id}`);

      // Follow the link. The doc surface paints the passage as a
      // decoration segment and lists the PDF group in the banner.
      await gotoOk(page, url.pathname + url.search);
      const banner = page.getByTestId("anchored-link-banner");
      await expect(banner).toBeVisible();
      await expect(banner).toContainText(QUOTED_TEXT);
      await expect(banner).toContainText(file.title);
      // The highlight arrives when the read-only editor mounts over the SSR
      // body — the same wait the banner's own on-load scroll retries out.
      await expect(page.locator(".anchored-link-highlight").first()).toBeVisible({ timeout: 15_000 });

      // Click through to the PDF group; its href carries ?sel= onward.
      await banner.getByRole("link", { name: file.title }).click();
      await expect(page).toHaveURL(new RegExp(`/pdf/${file.slug}\\?sel=`));
      await waitForViewer(page);
      // The part's region, drawn as the outline variant — no data-anno-id,
      // so it is invisible to the annotation click handler by construction.
      await expect(page.locator(".pdfViewer .page[data-page-number='1'] .annoRectLink")).not.toHaveCount(0, {
        timeout: 20_000,
      });
      await expect(page.getByTestId("anchored-link-banner")).toBeVisible();
    } finally {
      await deleteTestFile(file.id);
    }
  });

  test("an unreadable target's group is omitted without acknowledgment", async ({ page, secondUser }) => {
    // A PRIVATE doc (the admin's alone) plus a SHARED file, in one link.
    const doc = await createTestDoc({ authorEmail: ADMIN_EMAIL, bodyText: QUOTED_TEXT });
    const file = await makeFile();
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    try {
      await signIn(page, ADMIN_EMAIL);

      await gotoOk(page, `/doc/${doc.slug}`);
      await expect(bodyEditor(page)).toBeVisible();
      await expect(page.getByTestId("live-doc-synced")).toBeAttached({ timeout: 15_000 });
      await addDocSelectionToLink(page, QUOTED_TEXT);
      const tray = page.getByTestId("anchored-link-tray");
      await expect(tray).toContainText("1 passage", { timeout: 15_000 });

      await gotoOk(page, `/pdf/${file.slug}`);
      await waitForViewer(page);
      await selectPhrase(page, 1, PDF_PHRASE);
      await page.getByRole("button", { name: "Add to link" }).click();
      await expect(tray).toContainText("2 passages", { timeout: 15_000 });

      const url = await copyMintedLink(page);
      const sel = url.searchParams.get("sel")!;

      // A reader who may see the file but not the PRIVATE doc.
      const { page: readerPage } = await secondUser({ role: "AUTHORIZED" });

      // On the PDF's own ?sel= page: the banner and the outline DO render
      // for the file's passages — one unreadable target must not take the
      // whole link down (the deliberate deviation from §20i's conjunctive
      // default) — while nothing names, counts, or leaves a placeholder for
      // the private doc's group. "No acknowledgment" is the property: a
      // viewer cannot distinguish this link from one that referenced
      // nothing else.
      await gotoOk(readerPage, `/pdf/${file.slug}?sel=${sel}`);
      await waitForViewer(readerPage);
      const banner = readerPage.getByTestId("anchored-link-banner");
      await expect(banner).toBeVisible();
      await expect(banner).toContainText(PDF_PHRASE);
      await expect(readerPage.locator(".pdfViewer .page .annoRectLink")).not.toHaveCount(0, { timeout: 20_000 });
      await expect(banner).not.toContainText(doc.title);
      await expect(banner).not.toContainText("Also referenced");

      // And the private doc's own URL still forbids the page itself — the
      // route gate is untouched by any of this; ?sel= grants nothing.
      await readerPage.goto(`/doc/${doc.slug}?sel=${sel}`);
      await expect(readerPage.getByRole("heading", { name: "Forbidden" })).toBeVisible();
    } finally {
      await deleteTestFile(file.id);
      await deleteTestDoc(doc.id);
    }
  });

  test("banner group links paint the destination doc's highlights without a reload", async ({ page, sharedDoc }) => {
    // Following, not creating (the first test covers creation), so the link
    // is minted straight to the database. This pins the regression where a
    // banner group link — the app's first client-side doc→doc navigation —
    // painted nothing until a hard refresh: a reused reading editor resolved
    // the new doc's anchors against the old doc's text, and separately a
    // transition render replay recreated the reading view's Y.Doc and
    // setContent'd an empty handshake state over the editor; either way the
    // anchors detached permanently. The fixes are /doc/[slug]'s
    // key={doc.id} mount boundary and use-live-doc-content's
    // useState-owned Y.Doc plus pre-sync push guard — hard loads never hit
    // either path, which is why every assertion here follows a *click*.
    const docB = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: NAV_DOC_B_BODY });
    const link = await createTestAnchoredLink({
      creatorEmail: ADMIN_EMAIL,
      parts: [
        { docId: sharedDoc.id, from: QUOTE_FROM, to: QUOTE_TO },
        { docId: docB.id, from: NAV_B_FROM, to: NAV_B_TO },
      ],
    });
    const [partA, partB] = link.anchors;
    expect(partA.quotedText).toBe(QUOTED_TEXT);
    expect(partB.quotedText).toBe(NAV_B_QUOTE);
    try {
      await signIn(page, ADMIN_EMAIL);

      // Direct load paints doc A's part.
      await gotoOk(page, `/doc/${sharedDoc.id}?sel=${link.id}`);
      const banner = page.getByTestId("anchored-link-banner");
      await expect(banner).toBeVisible();
      await expect(page.locator(`[data-anchored-link-ids~="${partA.id}"]`).first()).toBeVisible({ timeout: 15_000 });

      // Client-side nav to the other doc's group.
      await banner.getByRole("link", { name: docB.title }).click();
      await expect(page).toHaveURL(new RegExp(`/doc/${docB.id}\\?sel=${link.id}`));
      await expect(page.getByTestId("anchored-link-banner")).toBeVisible();
      await expect(page.locator(`[data-anchored-link-ids~="${partB.id}"]`).first()).toBeVisible({ timeout: 15_000 });

      // And back again.
      await page.getByTestId("anchored-link-banner").getByRole("link", { name: sharedDoc.title }).click();
      await expect(page).toHaveURL(new RegExp(`/doc/${sharedDoc.id}\\?sel=${link.id}`));
      await expect(page.locator(`[data-anchored-link-ids~="${partA.id}"]`).first()).toBeVisible({ timeout: 15_000 });
    } finally {
      await deleteTestAnchoredLink(link.id);
      await deleteTestDoc(docB.id);
    }
  });
});
