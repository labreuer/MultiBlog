import { test, expect, signIn, gotoOk, selectTextInBody, bodyEditor, QUOTED_TEXT, QUOTE_FROM, QUOTE_TO } from "./fixtures";
import {
  ADMIN_EMAIL,
  TEST_PASSWORD,
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
/** Given to the draft before Copy link (docs/ANCHORED_LINKS.md, "Naming a link") — regex-safe for the title assertion. */
const LINK_NAME = "The fox and the retry rule";
/** A name that describes a target the reader may not see — and so must not reach them. */
const PRIVATE_NAME = "Names the private memo";

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
 * Mints the draft and returns the copied URL — the landing route's, which
 * routes per viewer at follow time (docs/ANCHORED_LINKS.md, "The landing
 * route"). Clipboard read needs the permission granted on the context
 * before this runs.
 */
async function copyMintedLink(page: import("@playwright/test").Page): Promise<URL> {
  const tray = page.getByTestId("anchored-link-tray");
  await tray.getByRole("button", { name: "Copy link" }).click();
  await expect(tray).toContainText("Recipients see only the passages they have permission to read", {
    timeout: 15_000,
  });
  const url = await page.evaluate(() => navigator.clipboard.readText());
  expect(url, "the minted URL landed on the clipboard").toContain("/link/");
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

      // The passage is painted in place as well as listed — the draft's own
      // dashed-underline highlight, delivered through the shared store's
      // notify rather than any refresh (docs/ANCHORED_LINKS.md, "Painting a
      // draft"). Asserting it here is also what covers the store: the tray
      // and this highlight read one fetch, so a stale one shows up as a
      // disagreement between the two.
      await expect(page.locator(".anchored-link-draft-highlight").first()).toBeVisible({ timeout: 15_000 });

      // Part 2: a PDF passage — and the tray still holds part 1, which is
      // the cross-page persistence claim (the server row IS the draft).
      await gotoOk(page, `/pdf/${file.slug}`);
      await waitForViewer(page);
      await selectPhrase(page, 1, PDF_PHRASE);
      await page.getByRole("button", { name: "Add to link" }).click();
      await expect(tray).toContainText("2 passages", { timeout: 15_000 });
      // Same statement on the PDF surface: the draft part's region, dashed.
      await expect(page.locator(".pdfViewer .page[data-page-number='1'] .annoRectDraftLink")).not.toHaveCount(0, {
        timeout: 20_000,
      });

      // A draft can be named before it is minted (docs/ANCHORED_LINKS.md,
      // "Naming a link"); the mint carries the name across. The field is
      // disabled while its save is in flight, so enabled means committed.
      const nameField = tray.getByRole("textbox", { name: "Link name" });
      await nameField.fill(LINK_NAME);
      await nameField.press("Enter");
      await expect(nameField).toBeEnabled();
      await expect(nameField).toHaveValue(LINK_NAME);

      const url = await copyMintedLink(page);
      const linkId = url.pathname.split("/").pop()!;
      expect(url.pathname).toBe(`/link/${linkId}`);
      expect(url.search).toBe("");

      // Follow the link. Two readable groups means there is no one place to
      // send this viewer, so the landing route renders the excerpt page:
      // both targets named, both stored quotes shown, each group with a way
      // into its surface.
      await gotoOk(page, url.pathname);
      const landing = page.getByTestId("anchored-link-landing");
      await expect(landing).toBeVisible();
      // The name is the heading and the tab title, in place of "Linked passages".
      await expect(landing.getByRole("heading", { level: 1 })).toHaveText(LINK_NAME);
      await expect(page).toHaveTitle(new RegExp(LINK_NAME));
      await expect(landing).toContainText(sharedDoc.title);
      await expect(landing).toContainText(QUOTED_TEXT);
      await expect(landing).toContainText(file.title);
      await expect(landing).toContainText(PDF_PHRASE);

      // Into the doc's context: the group's href carries ?sel=, and the doc
      // surface paints the passage as a decoration segment and lists the
      // PDF group in the banner.
      await landing
        .getByTestId("anchored-link-group")
        .filter({ hasText: sharedDoc.title })
        .getByRole("link", { name: "Open in context" })
        .click();
      await expect(page).toHaveURL(new RegExp(`/doc/${sharedDoc.id}\\?sel=${linkId}`));
      const banner = page.getByTestId("anchored-link-banner");
      await expect(banner).toBeVisible();
      await expect(banner).toContainText(LINK_NAME);
      await expect(banner).toContainText(QUOTED_TEXT);
      await expect(banner).toContainText(file.title);
      // The highlight arrives when the read-only editor mounts over the SSR
      // body — the same wait the banner's own on-load scroll retries out.
      await expect(page.locator(".anchored-link-highlight").first()).toBeVisible({ timeout: 15_000 });
      // And it is the *followed* look, not the draft one: minting cleared the
      // draft, so nothing on this page still claims to be in progress.
      await expect(page.locator(".anchored-link-draft-highlight")).toHaveCount(0);

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

      // And back out to the excerpts, explicitly: ?noredirect=1 is what
      // makes the landing route a page rather than a router.
      await page.getByTestId("anchored-link-banner").getByRole("link", { name: "View as excerpts" }).click();
      await expect(page).toHaveURL(new RegExp(`/link/${linkId}\\?noredirect=1`));
      await expect(page.getByTestId("anchored-link-landing")).toBeVisible();
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
      const sel = url.pathname.split("/").pop()!;

      // A reader who may see the file but not the PRIVATE doc.
      const { page: readerPage } = await secondUser({ role: "AUTHORIZED" });

      // On the PDF's own ?sel= page: the banner and the outline DO render
      // for the file's passages — one unreadable target must not take the
      // whole link down (the deliberate deviation from §20i's conjunctive
      // default) — while nothing names, counts, or leaves a placeholder for
      // the private doc's group. "No acknowledgment" is the property: a
      // viewer cannot distinguish this link from one that referenced
      // nothing else.
      // The minted URL itself routes per viewer: with the file the only
      // target this reader may see, the landing route sends them straight
      // to the PDF's ?sel= page. Minted against part 0 — the private doc —
      // this reader would once have met a Forbidden and never learned the
      // link held anything for them.
      await readerPage.goto(`/link/${sel}`);
      await readerPage.waitForURL(new RegExp(`/pdf/${file.slug}\\?sel=${sel}`));
      await waitForViewer(readerPage);
      const banner = readerPage.getByTestId("anchored-link-banner");
      await expect(banner).toBeVisible();
      await expect(banner).toContainText(PDF_PHRASE);
      await expect(readerPage.locator(".pdfViewer .page .annoRectLink")).not.toHaveCount(0, { timeout: 20_000 });
      await expect(banner).not.toContainText(doc.title);
      await expect(banner).not.toContainText("Also referenced");

      // Asked for explicitly, the excerpt page shows the same filtered
      // view: the file's group and its quote, and nothing naming the doc.
      await gotoOk(readerPage, `/link/${sel}?noredirect=1`);
      const landing = readerPage.getByTestId("anchored-link-landing");
      await expect(landing).toBeVisible();
      await expect(landing).toContainText(file.title);
      await expect(landing).toContainText(PDF_PHRASE);
      await expect(landing).not.toContainText(doc.title);
      await expect(landing.getByTestId("anchored-link-group")).toHaveCount(1);

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

  test("a signed-out reader keeps the link's passages through sign-in", async ({ browser, sharedDoc }) => {
    // The one URL a signed-out reader is likeliest to arrive by is a shared
    // anchored link, and the gate's sign-in redirect used to carry only the
    // pathname — so they signed in onto the right doc with its passages
    // silently gone, indistinguishable from a link that never resolved.
    // The claim here is the querystring's round trip: the callbackUrl the
    // gate writes still names ?sel=, and the page the form lands on paints
    // the part. Fixture-minted, like the nav test: creation is the first
    // test's business.
    const link = await createTestAnchoredLink({
      creatorEmail: ADMIN_EMAIL,
      parts: [{ docId: sharedDoc.id, from: QUOTE_FROM, to: QUOTE_TO }],
    });
    const [part] = link.anchors;
    // A fresh, empty context rather than the signed-in `page`: the gate only
    // answers "signed-out" to a visitor with no session at all.
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const reader = await context.newPage();
    try {
      const target = `/doc/${sharedDoc.id}?sel=${link.id}`;
      await reader.goto(target);
      await reader.waitForURL("**/sign-in?callbackUrl=*");
      expect(new URL(reader.url()).searchParams.get("callbackUrl")).toBe(target);

      // In place, not fixtures' signIn(): that helper navigates to /sign-in
      // first, which is exactly the trip that loses the callbackUrl.
      await reader.getByLabel("Email").fill(ADMIN_EMAIL);
      await reader.getByLabel("Password").fill(TEST_PASSWORD);
      await reader.getByRole("button", { name: "Sign in" }).click();

      await reader.waitForURL(`**/doc/${sharedDoc.id}?sel=${link.id}`);
      const banner = reader.getByTestId("anchored-link-banner");
      await expect(banner).toBeVisible();
      await expect(banner).toContainText(QUOTED_TEXT);
      await expect(reader.locator(`[data-anchored-link-ids~="${part.id}"]`).first()).toBeVisible({ timeout: 15_000 });
    } finally {
      await context.close();
      await deleteTestAnchoredLink(link.id);
    }
  });
  test("the landing route redirects only when there is one place to go", async ({ page, sharedDoc }) => {
    // Fixture-minted, docs only. The claims are the routing rule's arms
    // (docs/ANCHORED_LINKS.md, "The landing route"): one readable group
    // redirects into it, ?noredirect=1 declines that, two readable groups
    // render the excerpt page — which offers side-by-side for a doc pair,
    // since that surface fits exactly two docs — and an unknown id is a 404
    // rather than an empty page.
    const docB = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: NAV_DOC_B_BODY });
    const single = await createTestAnchoredLink({
      creatorEmail: ADMIN_EMAIL,
      parts: [{ docId: sharedDoc.id, from: QUOTE_FROM, to: QUOTE_TO }],
    });
    const pair = await createTestAnchoredLink({
      creatorEmail: ADMIN_EMAIL,
      parts: [
        { docId: sharedDoc.id, from: QUOTE_FROM, to: QUOTE_TO },
        { docId: docB.id, from: NAV_B_FROM, to: NAV_B_TO },
      ],
    });
    try {
      await signIn(page, ADMIN_EMAIL);

      // One readable group: straight into the doc, ?sel= and all.
      await page.goto(`/link/${single.id}`);
      await page.waitForURL(new RegExp(`/doc/${sharedDoc.id}\\?sel=${single.id}$`));
      await expect(page.getByTestId("anchored-link-banner")).toBeVisible();

      // The same link asked for as excerpts: no redirect, the quote shown,
      // the group's "Open in context" carrying ?sel= onward, and no
      // side-by-side offer for a single doc.
      await gotoOk(page, `/link/${single.id}?noredirect=1`);
      const landing = page.getByTestId("anchored-link-landing");
      await expect(landing).toBeVisible();
      await expect(landing).toContainText(QUOTED_TEXT);
      await expect(landing.getByRole("link", { name: "Open in context" })).toHaveAttribute(
        "href",
        `/doc/${sharedDoc.id}?sel=${single.id}`,
      );
      await expect(landing.getByRole("link", { name: "Open side by side" })).toHaveCount(0);

      // Two readable groups: the excerpt page, both quotes in part order,
      // and the doc-pair offer.
      await gotoOk(page, `/link/${pair.id}`);
      await expect(page).toHaveURL(new RegExp(`/link/${pair.id}$`));
      await expect(landing).toContainText(sharedDoc.title);
      await expect(landing).toContainText(docB.title);
      const quotes = landing.locator("blockquote");
      await expect(quotes).toHaveCount(2);
      await expect(quotes.nth(0)).toHaveText(QUOTED_TEXT);
      await expect(quotes.nth(1)).toHaveText(NAV_B_QUOTE);
      await expect(landing.getByRole("link", { name: "Open side by side" })).toHaveAttribute(
        "href",
        `/side-by-side/${sharedDoc.id}/${docB.id}`,
      );

      // Into doc B's context, then back out through the banner's own link.
      await landing
        .getByTestId("anchored-link-group")
        .filter({ hasText: docB.title })
        .getByRole("link", { name: "Open in context" })
        .click();
      await expect(page).toHaveURL(new RegExp(`/doc/${docB.id}\\?sel=${pair.id}`));
      const banner = page.getByTestId("anchored-link-banner");
      await expect(banner).toBeVisible();
      await expect(page.locator(`[data-anchored-link-ids~="${pair.anchors[1].id}"]`).first()).toBeVisible({
        timeout: 15_000,
      });
      await banner.getByRole("link", { name: "View as excerpts" }).click();
      await expect(page).toHaveURL(new RegExp(`/link/${pair.id}\\?noredirect=1`));
      await expect(page.getByTestId("anchored-link-landing")).toContainText(NAV_B_QUOTE);

      const missing = await page.goto("/link/no-such-link");
      expect(missing?.status()).toBe(404);
    } finally {
      await deleteTestAnchoredLink(pair.id);
      await deleteTestAnchoredLink(single.id);
      await deleteTestDoc(docB.id);
    }
  });

  test("a link with nothing the viewer may read says so and names nothing", async ({ page, secondUser }) => {
    // A PRIVATE doc (the admin's alone) as a link's only target. The
    // creator is routed into it; a reader who may not see the doc gets a
    // page that acknowledges the link — they hold its id already — and
    // nothing about what it points at: the per-target rule's silent
    // omission on the one surface that has to render *something* when every
    // group is filtered out.
    const doc = await createTestDoc({ authorEmail: ADMIN_EMAIL, bodyText: QUOTED_TEXT });
    const link = await createTestAnchoredLink({
      creatorEmail: ADMIN_EMAIL,
      parts: [{ docId: doc.id, from: 1, to: 1 + QUOTED_TEXT.length }],
      name: PRIVATE_NAME,
    });
    try {
      const { page: readerPage } = await secondUser({ role: "AUTHORIZED" });
      await gotoOk(readerPage, `/link/${link.id}`);
      const landing = readerPage.getByTestId("anchored-link-landing");
      await expect(landing).toBeVisible();
      await expect(landing).toContainText("no passages you have permission to read");
      await expect(landing).not.toContainText(doc.title);
      await expect(landing).not.toContainText(QUOTED_TEXT);
      await expect(landing.getByTestId("anchored-link-group")).toHaveCount(0);
      // The name rides the filtered view (docs/ANCHORED_LINKS.md, "Naming a
      // link"): a creator can name a link after what it points at, so a
      // page that names nothing shows no name either — not as the heading,
      // not as the tab title.
      await expect(landing).not.toContainText(PRIVATE_NAME);
      await expect(readerPage).not.toHaveTitle(new RegExp(PRIVATE_NAME));

      await signIn(page, ADMIN_EMAIL);
      await page.goto(`/link/${link.id}`);
      await page.waitForURL(new RegExp(`/doc/${doc.id}\\?sel=${link.id}$`));
      // And for the creator, who may read the doc, the banner carries it.
      await expect(page.getByTestId("anchored-link-banner")).toContainText(PRIVATE_NAME);
    } finally {
      await deleteTestAnchoredLink(link.id);
      await deleteTestDoc(doc.id);
    }
  });

  test("a signed-out reader keeps ?noredirect= through sign-in on the landing route", async ({ browser, sharedDoc }) => {
    // The landing route is now the URL every shared link *is*, so it is the
    // gate a signed-out recipient meets first. The callbackUrl must carry
    // the querystring: signing in onto `/link/<id>` without it would run
    // the redirect the reader had declined.
    const link = await createTestAnchoredLink({
      creatorEmail: ADMIN_EMAIL,
      parts: [{ docId: sharedDoc.id, from: QUOTE_FROM, to: QUOTE_TO }],
    });
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const reader = await context.newPage();
    try {
      const target = `/link/${link.id}?noredirect=1`;
      await reader.goto(target);
      await reader.waitForURL("**/sign-in?callbackUrl=*");
      expect(new URL(reader.url()).searchParams.get("callbackUrl")).toBe(target);

      await reader.getByLabel("Email").fill(ADMIN_EMAIL);
      await reader.getByLabel("Password").fill(TEST_PASSWORD);
      await reader.getByRole("button", { name: "Sign in" }).click();

      await reader.waitForURL(new RegExp(`/link/${link.id}\\?noredirect=1$`));
      await expect(reader.getByTestId("anchored-link-landing")).toContainText(QUOTED_TEXT);
    } finally {
      await context.close();
      await deleteTestAnchoredLink(link.id);
    }
  });
});
