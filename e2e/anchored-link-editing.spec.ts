import { test, expect, gotoOk, selectTextInBody, bodyEditor, QUOTED_BODY, QUOTED_TEXT, QUOTE_FROM, QUOTE_TO } from "./fixtures";
import {
  createTestAnchoredLink,
  createTestDoc,
  createTestFile,
  deleteTestAnchoredLink,
  deleteTestDoc,
  deleteTestFile,
} from "./db";

// docs/ANCHORED_LINKS.md, "Editing a minted link" — a minted link back in
// its creator's tray: reopen, add, remove, reorder, Done, with the URL
// resolving for recipients throughout.
//
// The load-bearing claims: edits are *live* on the row recipients follow
// (a second viewer sees the new set with no re-mint); a shared link never
// drops to zero passages; and the Edit affordance is a visible state — it
// waits, and says why, while a draft with passages is open, and frees
// itself on the same page the moment that draft is finished. Editing is the
// creator's alone: an admin following the link gets no Edit at all.
//
// Every creator here is a throwaway (secondUser): a draft or a reopened
// link occupies the creator's one-open slot (the partial unique index), and
// anchored-links.spec.ts assembles drafts as the shared admin in parallel.

const BODY = "Editing keeps the URL: the first passage stays put while a second passage arrives later.";
/** A name given from the tray (docs/ANCHORED_LINKS.md, "Naming a link") — regex-safe, since a title assertion uses it. */
const LINK_NAME = "Both readings of the retry rule";
const QUOTE_A = "first passage stays put";
const QUOTE_B = "second passage arrives later";
// A single paragraph, so character index `i` sits at ProseMirror position
// `i + 1` (the QUOTED_BODY convention, e2e/fixtures.ts).
const A_FROM = BODY.indexOf(QUOTE_A) + 1;
const A_TO = A_FROM + QUOTE_A.length;

// anchored-links.spec.ts's PDF fixture and recipes, repeated rather than
// exported: a spec importing another spec's helpers would register that
// spec's tests twice.
const PAGE_ONE = "The quick brown fox jumps over the lazy dog on page one.";
const PAGE_TWO = "A distinctive phrase for page two: xylophone marmalade.";
const PDF_PHRASE = "brown fox jumps";
const PDF_PHRASE_TWO = "lazy dog";

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

/** The reading view's selection popover → "Add to link" (anchored-links.spec.ts's recipe). */
async function addDocSelectionToLink(page: import("@playwright/test").Page, needle: string) {
  await selectTextInBody(page, needle);
  const popup = page.getByTestId("annotation-popup");
  await expect(popup).toBeVisible();
  await popup.getByRole("button", { name: "Add to link" }).click();
}

/** /links' data rows — every one carries a passage count (links.spec.ts). */
function linkRows(page: import("@playwright/test").Page) {
  return page.locator("tbody tr").filter({ hasText: /\d+ passages?/ });
}

test.describe("editing an anchored link", () => {
  test("the creator reopens a minted link, changes its passages, and recipients follow the new set", async ({
    page,
    secondUser,
  }) => {
    const { user: creator, page: creatorPage } = await secondUser({ role: "AUTHOR" });
    const doc = await createTestDoc({ authorEmail: creator.email, visibility: "SHARED", bodyText: BODY });
    const link = await createTestAnchoredLink({
      creatorEmail: creator.email,
      parts: [{ docId: doc.id, from: A_FROM, to: A_TO }],
    });
    try {
      // The excerpt page offers Edit to the creator; the tray is mounted
      // there, so opening shows the link's parts on the same page.
      await gotoOk(creatorPage, `/link/${link.id}?noredirect=1`);
      const landing = creatorPage.getByTestId("anchored-link-landing");
      await landing.getByRole("button", { name: "Edit link" }).click();
      const tray = creatorPage.getByTestId("anchored-link-tray");
      await expect(tray).toBeVisible();
      await expect(tray).toContainText("Editing link");
      await expect(tray).toContainText("1 passage");
      await expect(landing.getByTestId("edit-link-open-here")).toBeVisible();

      // Name it from the tray's field (docs/ANCHORED_LINKS.md, "Naming a
      // link"): committed on Enter, and the page's own heading follows from
      // the store the tray re-read — no refresh, no navigation.
      const nameField = tray.getByRole("textbox", { name: "Link name" });
      await expect(nameField).toHaveValue("");
      await nameField.fill(LINK_NAME);
      await nameField.press("Enter");
      await expect(landing.getByRole("heading", { level: 1 })).toHaveText(LINK_NAME);

      // Into context to add a passage. The tray follows (the server row is
      // the persistence), the banner shows the same open-here state, and
      // the followed part wears the in-progress look while it is open.
      await landing.getByRole("link", { name: "Open in context" }).click();
      await expect(creatorPage).toHaveURL(new RegExp(`/doc/${doc.id}\\?sel=${link.id}`));
      await expect(bodyEditor(creatorPage)).toBeVisible();
      await expect(creatorPage.getByTestId("live-doc-synced")).toBeAttached({ timeout: 15_000 });
      await expect(creatorPage.getByTestId("anchored-link-banner").getByTestId("edit-link-open-here")).toBeVisible();
      // The banner's title is the name too, on the reading surface.
      await expect(creatorPage.getByTestId("anchored-link-banner")).toContainText(LINK_NAME);
      await expect(creatorPage.locator(".anchored-link-draft-highlight").first()).toBeVisible({ timeout: 15_000 });
      await addDocSelectionToLink(creatorPage, QUOTE_B);
      await expect(tray).toContainText("2 passages", { timeout: 15_000 });
      await expect(tray).toContainText(QUOTE_B);

      // Reorder by dragging B's grip above A: the drop line shows on A's
      // row before release, and the order persists on release. Then remove
      // A. Part order is the order every reader lists, so the landing page
      // and banner below prove both.
      const rows = tray.getByRole("listitem");
      const grip = rows.nth(1).getByRole("button", { name: "Drag to reorder" });
      const gripBox = (await grip.boundingBox())!;
      const firstBox = (await rows.nth(0).boundingBox())!;
      await creatorPage.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2);
      await creatorPage.mouse.down();
      await creatorPage.mouse.move(gripBox.x + gripBox.width / 2, firstBox.y + 1, { steps: 6 });
      await expect(rows.nth(0)).toHaveAttribute("data-drop", "before");
      await creatorPage.mouse.up();
      await expect(rows.first()).toContainText(QUOTE_B);
      await tray.getByRole("button", { name: "Remove this passage from the link" }).nth(1).click();
      await expect(tray).toContainText("1 passage");
      await expect(tray).not.toContainText(QUOTE_A);
      await tray.getByRole("button", { name: "Done" }).click();
      await expect(tray).toBeHidden();

      // A recipient — the admin, not the creator — follows the same URL: one
      // readable group, so the landing route redirects into the doc, whose
      // banner lists B and no longer A. No re-mint happened; nothing about
      // the URL changed.
      await gotoOk(page, `/link/${link.id}`);
      await expect(page).toHaveURL(new RegExp(`/doc/${doc.id}\\?sel=${link.id}`));
      const banner = page.getByTestId("anchored-link-banner");
      await expect(banner).toContainText(LINK_NAME);
      await expect(banner).toContainText(QUOTE_B);
      await expect(banner).not.toContainText(QUOTE_A);
      // Editing is the creator's alone: an admin is a moderator for delete
      // and nobody for edit, so no affordance renders anywhere for them.
      await expect(banner.getByTestId("edit-link")).toHaveCount(0);
      await gotoOk(page, `/link/${link.id}?noredirect=1`);
      const recipientLanding = page.getByTestId("anchored-link-landing");
      await expect(recipientLanding.getByRole("heading", { level: 1 })).toHaveText(LINK_NAME);
      await expect(page).toHaveTitle(new RegExp(LINK_NAME));
      await expect(recipientLanding).toContainText("edited");
      await expect(recipientLanding.getByTestId("edit-link")).toHaveCount(0);
    } finally {
      await deleteTestAnchoredLink(link.id);
      await deleteTestDoc(doc.id);
    }
  });

  test("a draft with passages holds Edit visibly until finished, and a shared link keeps its last passage", async ({
    secondUser,
  }) => {
    const { user: creator, page: creatorPage } = await secondUser({ role: "AUTHOR" });
    const doc = await createTestDoc({ authorEmail: creator.email, visibility: "SHARED", bodyText: QUOTED_BODY });
    const link = await createTestAnchoredLink({
      creatorEmail: creator.email,
      parts: [{ docId: doc.id, from: QUOTE_FROM, to: QUOTE_TO }],
    });
    const draft = await createTestAnchoredLink({
      creatorEmail: creator.email,
      parts: [{ docId: doc.id, from: QUOTE_FROM, to: QUOTE_TO }],
      minted: false,
    });
    try {
      await creatorPage.context().grantPermissions(["clipboard-read", "clipboard-write"]);
      await gotoOk(creatorPage, `/link/${link.id}?noredirect=1`);
      const edit = creatorPage.getByTestId("edit-link");
      const editButton = edit.getByRole("button", { name: "Edit link" });
      // Disabled *with the reason as text* — the same sentence the server
      // refuses with — rather than a tooltip a phone would never show.
      await expect(editButton).toBeDisabled();
      await expect(edit).toContainText("Copy or discard your draft link first.");

      // The draft is in the tray on this very page. Discarding it frees the
      // button with no reload: both read one store.
      const tray = creatorPage.getByTestId("anchored-link-tray");
      await expect(tray).toContainText("Draft link");
      await tray.getByRole("button", { name: "Discard" }).click();
      await expect(editButton).toBeEnabled();
      await editButton.click();
      await expect(tray).toContainText("Editing link");

      // A shared link never drops to zero passages: the remove refuses and
      // says what to do instead.
      await tray.getByRole("button", { name: "Remove this passage from the link" }).click();
      await expect(tray).toContainText("A shared link keeps at least one passage");
      await expect(tray).toContainText("1 passage");
      await expect(tray).toContainText(QUOTED_TEXT);

      // Copy link on a reopened link copies the URL it has had all along —
      // no mint, and the tray stays.
      await tray.getByRole("button", { name: "Copy link" }).click();
      await expect(tray).toContainText("Link copied.");
      expect(await creatorPage.evaluate(() => navigator.clipboard.readText())).toContain(`/link/${link.id}`);
      await expect(tray).toContainText("Editing link");

      // Deleting a reopened link closes the edit with it, so a restore
      // never brings back a link that is "open" beside whatever the creator
      // opened since: after restore, Edit is offered afresh and no tray shows.
      await gotoOk(creatorPage, `/links?doc=${doc.id}`);
      const row = linkRows(creatorPage).filter({ hasText: doc.title });
      await expect(row).toContainText("editing");
      await row.getByRole("button", { name: "Delete link" }).click();
      await expect(row.getByRole("button", { name: "Restore link" })).toBeVisible();
      await row.getByRole("button", { name: "Restore link" }).click();
      await expect(row.getByRole("button", { name: "Delete link" })).toBeVisible();
      await gotoOk(creatorPage, `/link/${link.id}?noredirect=1`);
      await expect(creatorPage.getByTestId("edit-link").getByRole("button", { name: "Edit link" })).toBeEnabled();
      await expect(creatorPage.getByTestId("anchored-link-tray")).toHaveCount(0);
    } finally {
      await deleteTestAnchoredLink(draft.id);
      await deleteTestAnchoredLink(link.id);
      await deleteTestDoc(doc.id);
    }
  });

  test("/links offers Edit on the viewer's own minted links, an empty draft gives way, and the tray is where it lands", async ({
    page,
    secondUser,
  }) => {
    const { user: creator, page: creatorPage } = await secondUser({ role: "AUTHOR" });
    const doc = await createTestDoc({ authorEmail: creator.email, visibility: "SHARED", bodyText: QUOTED_BODY });
    const link = await createTestAnchoredLink({
      creatorEmail: creator.email,
      parts: [{ docId: doc.id, from: QUOTE_FROM, to: QUOTE_TO }],
    });
    // The row removing a draft's last part leaves behind: nothing in it to
    // finish, so Edit is offered and the open discards it.
    const emptyDraft = await createTestAnchoredLink({ creatorEmail: creator.email, parts: [], minted: false });
    try {
      await gotoOk(creatorPage, `/links?doc=${doc.id}`);
      const row = linkRows(creatorPage).filter({ hasText: doc.title });
      await expect(row).toHaveCount(1);
      const editButton = row.getByRole("button", { name: "Edit link" });
      await expect(editButton).toBeEnabled();
      await editButton.click();
      await expect(creatorPage).toHaveURL(new RegExp(`/link/${link.id}\\?noredirect=1`));
      await expect(creatorPage.getByTestId("anchored-link-tray")).toContainText("Editing link");

      // The table reads the state back, and the admin — able to delete this
      // row as a moderator — is offered no Edit on it.
      await gotoOk(creatorPage, `/links?doc=${doc.id}`);
      await expect(row).toContainText("editing");
      await expect(row.getByTestId("edit-link-open-here")).toBeVisible();
      await gotoOk(page, `/links?doc=${doc.id}`);
      const adminRow = linkRows(page).filter({ hasText: doc.title });
      await expect(adminRow).toHaveCount(1);
      await expect(adminRow.getByRole("button", { name: "Delete link" })).toBeEnabled();
      await expect(adminRow.getByTestId("edit-link")).toHaveCount(0);
    } finally {
      await deleteTestAnchoredLink(emptyDraft.id);
      await deleteTestAnchoredLink(link.id);
      await deleteTestDoc(doc.id);
    }
  });

  test("on the PDF surface the banner's Edit reopens the link, its region draws once and dashed, and Done returns it to solid", async ({
    secondUser,
  }) => {
    const { user: creator, page: creatorPage } = await secondUser({ role: "AUTHOR" });
    const file = await createTestFile({
      ownerEmail: creator.email,
      visibility: "SHARED",
      pages: [[PAGE_ONE], [PAGE_TWO]],
    });
    let linkId: string | null = null;
    try {
      await creatorPage.context().grantPermissions(["clipboard-read", "clipboard-write"]);
      // Minted through the UI: the fixture writes doc parts only, and this
      // test is about a PDF part.
      await gotoOk(creatorPage, `/pdf/${file.slug}`);
      await waitForViewer(creatorPage);
      await selectPhrase(creatorPage, 1, PDF_PHRASE);
      await creatorPage.getByRole("button", { name: "Add to link" }).click();
      const tray = creatorPage.getByTestId("anchored-link-tray");
      await expect(tray).toContainText("1 passage", { timeout: 15_000 });
      await tray.getByRole("button", { name: "Copy link" }).click();
      await expect(tray).toContainText("Recipients see only the passages", { timeout: 15_000 });
      const url = new URL(await creatorPage.evaluate(() => navigator.clipboard.readText()));
      linkId = url.pathname.split("/").pop()!;

      // Following it as the creator: one readable group, so the landing
      // route redirects into the PDF, whose banner — inside the ssr:false
      // island — offers Edit off the same module-scope store the tray reads.
      await gotoOk(creatorPage, url.pathname);
      await expect(creatorPage).toHaveURL(new RegExp(`/pdf/${file.slug}\\?sel=${linkId}`));
      await waitForViewer(creatorPage);
      const pageOne = creatorPage.locator(".pdfViewer .page[data-page-number='1']");
      await expect(pageOne.locator(".annoRectLink")).toHaveCount(1, { timeout: 20_000 });
      await expect(pageOne.locator(".annoRectDraftLink")).toHaveCount(0);
      const banner = creatorPage.getByTestId("anchored-link-banner");
      await banner.getByRole("button", { name: "Edit link" }).click();
      await expect(tray).toContainText("Editing link");
      await expect(banner.getByTestId("edit-link-open-here")).toBeVisible();
      // One region, dashed (both classes on one element): the followed
      // outline yields to the open one rather than stacking under it, which
      // is what would make the count two.
      await expect(pageOne.locator(".annoRectDraftLink")).toHaveCount(1, { timeout: 20_000 });
      await expect(pageOne.locator(".annoRectLink")).toHaveCount(1);

      // A second PDF passage lands on the reopened link, painted dashed too.
      await selectPhrase(creatorPage, 1, PDF_PHRASE_TWO);
      await creatorPage.getByRole("button", { name: "Add to link" }).click();
      await expect(tray).toContainText("2 passages", { timeout: 15_000 });
      await expect(pageOne.locator(".annoRectDraftLink")).toHaveCount(2, { timeout: 20_000 });

      // Done: the in-progress paint goes, and the followed part is drawn
      // solid again from the props this load arrived with (which predate the
      // second part — it shows on the next load, as the banner test in
      // anchored-links.spec.ts proves for the doc side).
      await tray.getByRole("button", { name: "Done" }).click();
      await expect(tray).toBeHidden();
      await expect(pageOne.locator(".annoRectDraftLink")).toHaveCount(0, { timeout: 20_000 });
      await expect(pageOne.locator(".annoRectLink")).toHaveCount(1);
    } finally {
      if (linkId) await deleteTestAnchoredLink(linkId);
      await deleteTestFile(file.id);
    }
  });

  test("opening a second minted link closes the one mid-edit, whose edits were live anyway", async ({ secondUser }) => {
    const { user: creator, page: creatorPage } = await secondUser({ role: "AUTHOR" });
    const docA = await createTestDoc({ authorEmail: creator.email, visibility: "SHARED", bodyText: QUOTED_BODY });
    const docB = await createTestDoc({ authorEmail: creator.email, visibility: "SHARED", bodyText: QUOTED_BODY });
    // The fixture's `reopened` — link A already in the tray, as Edit leaves it.
    const linkA = await createTestAnchoredLink({
      creatorEmail: creator.email,
      parts: [{ docId: docA.id, from: QUOTE_FROM, to: QUOTE_TO }],
      reopened: true,
    });
    const linkB = await createTestAnchoredLink({
      creatorEmail: creator.email,
      parts: [{ docId: docB.id, from: QUOTE_FROM, to: QUOTE_TO }],
    });
    try {
      // B's excerpt page: the tray shows A, and B's Edit is *ready*, not
      // blocked — a reopened link has nothing to finish, unlike a draft.
      await gotoOk(creatorPage, `/link/${linkB.id}?noredirect=1`);
      const tray = creatorPage.getByTestId("anchored-link-tray");
      await expect(tray).toContainText("Editing link");
      await expect(tray).toContainText(docA.title);
      const edit = creatorPage.getByTestId("edit-link");
      const editButton = edit.getByRole("button", { name: "Edit link" });
      await expect(editButton).toBeEnabled();
      await expect(edit).not.toContainText("Copy or discard");
      await editButton.click();
      await expect(creatorPage.getByTestId("edit-link-open-here")).toBeVisible();
      await expect(tray).toContainText(docB.title);
      await expect(tray).not.toContainText(docA.title);

      // A is closed: its excerpt page offers Edit afresh, and /links reads
      // *editing* on B's row alone.
      await gotoOk(creatorPage, `/link/${linkA.id}?noredirect=1`);
      await expect(creatorPage.getByTestId("edit-link").getByRole("button", { name: "Edit link" })).toBeEnabled();
      await gotoOk(creatorPage, `/links?owners=${creator.slug}`);
      await expect(linkRows(creatorPage).filter({ hasText: docA.title })).not.toContainText("editing");
      await expect(linkRows(creatorPage).filter({ hasText: docB.title })).toContainText("editing");
    } finally {
      await deleteTestAnchoredLink(linkA.id);
      await deleteTestAnchoredLink(linkB.id);
      await deleteTestDoc(docA.id);
      await deleteTestDoc(docB.id);
    }
  });
});
