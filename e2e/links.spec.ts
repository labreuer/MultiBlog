import { test, expect, gotoOk, QUOTED_BODY, QUOTED_TEXT, QUOTE_FROM, QUOTE_TO } from "./fixtures";
import { ADMIN_EMAIL, createTestAnchoredLink, createTestDoc, deleteTestAnchoredLink, deleteTestDoc } from "./db";

// docs/ANCHORED_LINKS.md, "The management table" — /links, and the header
// entry that reaches it.
//
// The load-bearing claims are the table's two scoping rules, both restated
// from the follow path (docs/PERMISSIONS.md): a row lists for a viewer who
// may read *some* target of it and shows *only* the parts they could follow,
// with an unreadable target acknowledged nowhere — not in a cell, not in a
// count, and not through ?q=, which would otherwise be a probe into quotes
// the viewer cannot see. The rest is the kit's ordinary shape (delete/restore
// as a soft delete, the querystring as state), pinned only where this table
// decides something the others don't: who may delete, and that a draft
// lists but is never deleted from here.
//
// Every link is fixture-minted (createTestAnchoredLink); creation through the
// tray is anchored-links.spec.ts's business. Rows are found through ?doc=
// deep links on this test's own docs, so parallel workers' links never make
// a row ambiguous.

/**
 * The header's nav as a signed-in reader sees it: visible links only, in DOM
 * order. `/` is statically generated, so its header renders signed-out and
 * fills in from useSession() after hydration — read the names only once the
 * role-gated entry this spec is about has arrived, or the list is the
 * anonymous one (brand, Log in, Sign up) however signed in the context is.
 */
async function headerLinkNames(page: import("@playwright/test").Page): Promise<string[]> {
  const header = page.locator("header");
  await expect(header.getByRole("link", { name: "Links", exact: true })).toBeVisible();
  return header.getByRole("link").allInnerTexts();
}

const NO_ROWS = "No links matching the criteria.";

/** The name the Name test settles on — what "  Retry   rule, both readings " normalises to. */
const NAME = "Retry rule, both readings";
/** The row-status border once a cell's save lands — admin-table.spec.ts's SAVED, --success in light mode. */
const SAVED = "rgb(0, 170, 85)";

/** The table's data rows — every one carries a passage count; the header row says "Passages", the empty row neither. */
function linkRows(page: import("@playwright/test").Page) {
  return page.locator("tbody tr").filter({ hasText: /\d+ passages?/ });
}

test.describe("/links", () => {
  test("the header runs Files, Links, Users in that order, and ends before Users for a non-admin", async ({
    page,
    secondUser,
  }) => {
    // Files and Users swapped, with Links between them: content first, people
    // last. For an admin all three are present and adjacent.
    await gotoOk(page, "/");
    const admin = await headerLinkNames(page);
    expect(admin.indexOf("Files"), `admin header: ${admin.join(" | ")}`).toBeGreaterThan(-1);
    expect(admin.indexOf("Links")).toBe(admin.indexOf("Files") + 1);
    expect(admin.indexOf("Users")).toBe(admin.indexOf("Links") + 1);

    // An AUTHOR keeps Files and Links in the same order and simply has no
    // Users entry — the row reads the same for every role and only ends
    // earlier.
    const { page: authorPage } = await secondUser({ role: "AUTHOR" });
    await gotoOk(authorPage, "/");
    const author = await headerLinkNames(authorPage);
    expect(author.indexOf("Links"), `author header: ${author.join(" | ")}`).toBe(author.indexOf("Files") + 1);
    expect(author).not.toContain("Users");
    await authorPage.getByRole("link", { name: "Links", exact: true }).click();
    await expect(authorPage).toHaveURL(/\/links$/);
    await expect(authorPage.getByRole("heading", { name: "Links" })).toBeVisible();
  });

  test("a row lists by what the viewer may read, shows only that, and search cannot probe the rest", async ({
    page,
    sharedDoc,
    secondUser,
  }) => {
    // A token that appears nowhere but in this test's PRIVATE doc, so ?q=
    // on it is a clean probe: the admin (the doc's author) finds the row,
    // an AUTHOR who cannot read the doc must not.
    const token = `xq${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const privateBody = `A private sentence holding the token ${token} for the search probe.`;
    const privateQuote = `token ${token}`;
    const privateFrom = privateBody.indexOf(privateQuote) + 1;
    const privateDoc = await createTestDoc({ authorEmail: ADMIN_EMAIL, bodyText: privateBody });
    // One link spanning both docs, and one that points into the private doc
    // alone — the row that must not exist for anyone but its author.
    const mixed = await createTestAnchoredLink({
      creatorEmail: ADMIN_EMAIL,
      parts: [
        { docId: sharedDoc.id, from: QUOTE_FROM, to: QUOTE_TO },
        { docId: privateDoc.id, from: privateFrom, to: privateFrom + privateQuote.length },
      ],
    });
    const privateOnly = await createTestAnchoredLink({
      creatorEmail: ADMIN_EMAIL,
      parts: [{ docId: privateDoc.id, from: privateFrom, to: privateFrom + privateQuote.length }],
    });
    expect(mixed.anchors[1].quotedText).toBe(privateQuote);
    try {
      // The creator, who may read both: two rows under the private doc's
      // deep link, and the mixed one shows both passages and both targets,
      // each target's title carrying ?sel= into its own surface.
      await gotoOk(page, `/links?doc=${privateDoc.id}`);
      await expect(linkRows(page)).toHaveCount(2);
      const mixedRow = linkRows(page).filter({ hasText: sharedDoc.title });
      await expect(mixedRow).toContainText("2 passages");
      await expect(mixedRow).toContainText(QUOTED_TEXT);
      await expect(mixedRow).toContainText(privateQuote);
      await expect(mixedRow.getByRole("link", { name: privateDoc.title })).toHaveAttribute(
        "href",
        `/doc/${privateDoc.id}?sel=${mixed.id}`,
      );
      await expect(mixedRow.getByRole("link", { name: "2 passages" })).toHaveAttribute(
        "href",
        `/link/${mixed.id}?noredirect=1`,
      );
      // And the search finds it by the private quote, for someone who may
      // read that quote.
      await gotoOk(page, `/links?q=${token}`);
      await expect(linkRows(page)).toHaveCount(2);

      // An AUTHOR who may read the SHARED doc and not the PRIVATE one. The
      // mixed link lists — one readable target is enough — with the shared
      // passage alone: no private quote, no private title, a count of one.
      // The private-only link is not a row at all.
      const { page: authorPage } = await secondUser({ role: "AUTHOR" });
      await gotoOk(authorPage, `/links?doc=${privateDoc.id}`);
      const rows = linkRows(authorPage);
      await expect(rows).toHaveCount(1);
      await expect(rows).toContainText("1 passage");
      await expect(rows).toContainText(QUOTED_TEXT);
      await expect(rows).toContainText(sharedDoc.title);
      await expect(rows).not.toContainText(privateDoc.title);
      await expect(rows).not.toContainText(token);
      // Not the creator and not a moderator: the row is read-only for them.
      await expect(rows.getByRole("button", { name: "Delete link" })).toBeDisabled();

      // The probe: the same search that found two rows for the author of the
      // private doc finds nothing for a viewer who cannot read it — even
      // though one of those rows is otherwise theirs to see.
      await gotoOk(authorPage, `/links?q=${token}`);
      await expect(authorPage.getByText(NO_ROWS)).toBeVisible();
    } finally {
      await deleteTestAnchoredLink(privateOnly.id);
      await deleteTestAnchoredLink(mixed.id);
      await deleteTestDoc(privateDoc.id);
    }
  });

  test("deleting is a soft delete a moderator may make and the creator may undo", async ({
    page,
    sharedDoc,
    secondUser,
  }) => {
    const link = await createTestAnchoredLink({
      creatorEmail: ADMIN_EMAIL,
      parts: [{ docId: sharedDoc.id, from: QUOTE_FROM, to: QUOTE_TO }],
    });
    try {
      // An EDITOR is not the creator but is a moderator: the button is live,
      // and the action goes through.
      const { page: editorPage } = await secondUser({ role: "EDITOR" });
      await gotoOk(editorPage, `/links?doc=${sharedDoc.id}`);
      const editorRow = linkRows(editorPage).filter({ hasText: sharedDoc.title });
      await expect(editorRow).toHaveCount(1);
      await editorRow.getByRole("button", { name: "Delete link" }).click();
      // The kit keeps the row on screen, now deleted, so the mis-click undo
      // is one more click — and so this can assert the flip.
      await expect(editorRow.getByRole("button", { name: "Restore link" })).toBeVisible();

      // Deleted means the URL stops resolving for everyone, creator included.
      const followed = await page.goto(`/link/${link.id}`);
      expect(followed?.status(), "a deleted link 404s").toBe(404);

      // Gone from the creator's default view, present under show-deleted.
      await gotoOk(page, `/links?doc=${sharedDoc.id}`);
      await expect(page.getByText(NO_ROWS)).toBeVisible();
      await gotoOk(page, `/links?doc=${sharedDoc.id}&deleted=1`);
      const row = linkRows(page).filter({ hasText: sharedDoc.title });
      await expect(row).toHaveCount(1);

      // The creator restores it, and the URL resolves again.
      await row.getByRole("button", { name: "Restore link" }).click();
      await expect(row.getByRole("button", { name: "Delete link" })).toBeVisible();
      await gotoOk(page, `/link/${link.id}?noredirect=1`);
      await expect(page.getByTestId("anchored-link-landing")).toContainText(QUOTED_TEXT);
    } finally {
      await deleteTestAnchoredLink(link.id);
    }
  });

  test("a draft lists for its creator alone, as a draft, and is not deletable from here", async ({
    page,
    secondUser,
  }) => {
    // A throwaway creator, so the fixture draft occupies *their* one draft
    // slot and never the shared admin's (createTestAnchoredLink's comment).
    const { user: author, page: authorPage } = await secondUser({ role: "AUTHOR" });
    const doc = await createTestDoc({ authorEmail: author.email, visibility: "SHARED", bodyText: QUOTED_BODY });
    const draft = await createTestAnchoredLink({
      creatorEmail: author.email,
      parts: [{ docId: doc.id, from: QUOTE_FROM, to: QUOTE_TO }],
      minted: false,
    });
    try {
      await gotoOk(authorPage, `/links?doc=${doc.id}`);
      const row = linkRows(authorPage).filter({ hasText: doc.title });
      await expect(row).toHaveCount(1);
      // Minted at reads as a state, not a blank — and the one exit for a
      // draft is the tray's Discard, so the table's control is off even for
      // its owner.
      await expect(row).toContainText("draft");
      await expect(row.getByRole("button", { name: "Delete link" })).toBeDisabled();

      // Someone else's draft does not exist, whatever the role: the admin
      // sees no row under the same deep link, though the doc is SHARED and
      // the passage would be readable once minted.
      await gotoOk(page, `/links?doc=${doc.id}`);
      await expect(page.getByText(NO_ROWS)).toBeVisible();
    } finally {
      await deleteTestAnchoredLink(draft.id);
      await deleteTestDoc(doc.id);
    }
  });

  test("Name edits in place for the creator and a moderator, reads as text for anyone else, and is searchable", async ({
    page,
    sharedDoc,
    secondUser,
  }) => {
    // docs/ANCHORED_LINKS.md, "Naming a link" — the in-place cell, the
    // UsersTable shape. Who gets the field is the delete rule's arm
    // (docs/PERMISSIONS.md): the creator, or a moderator once minted.
    const link = await createTestAnchoredLink({
      creatorEmail: ADMIN_EMAIL,
      parts: [{ docId: sharedDoc.id, from: QUOTE_FROM, to: QUOTE_TO }],
    });
    try {
      // An EDITOR is not the creator but is a moderator, so the cell is a
      // field. The value it settles on is what the server stored — trimmed,
      // runs of whitespace collapsed — and a reload proves it landed.
      const { page: editorPage } = await secondUser({ role: "EDITOR" });
      await gotoOk(editorPage, `/links?doc=${sharedDoc.id}`);
      const editorRow = () => linkRows(editorPage).filter({ hasText: sharedDoc.title });
      await expect(editorRow()).toHaveCount(1);
      const editorField = () => editorRow().getByRole("textbox", { name: "Link name" });
      await editorField().fill("  Retry   rule, both readings ");
      await editorField().press("Enter");
      await expect(editorField()).toHaveValue(NAME);
      await editorPage.reload();
      await expect(editorField()).toHaveValue(NAME);

      // ?q= finds it by name — the creator's text, searched unbounded by the
      // readability clause that bounds the quotes.
      await gotoOk(editorPage, `/links?doc=${sharedDoc.id}&q=${encodeURIComponent("both readings")}`);
      await expect(linkRows(editorPage)).toHaveCount(1);
      await gotoOk(editorPage, `/links?doc=${sharedDoc.id}&q=${encodeURIComponent("no such name")}`);
      await expect(editorPage.getByText(NO_ROWS)).toBeVisible();

      // An AUTHOR is neither creator nor moderator: the name reads as text,
      // with no field to edit it.
      const { page: authorPage } = await secondUser({ role: "AUTHOR" });
      await gotoOk(authorPage, `/links?doc=${sharedDoc.id}`);
      const authorRow = linkRows(authorPage).filter({ hasText: sharedDoc.title });
      await expect(authorRow).toContainText(NAME);
      await expect(authorRow.getByRole("textbox", { name: "Link name" })).toHaveCount(0);

      // Recipients see the name as the excerpt page's heading. The creator
      // clears it from here — the field's value is the empty string before
      // and after, so the save is waited on through the row's status border,
      // as admin-table.spec.ts reads it — and the heading goes back to the
      // generic one.
      const heading = () => page.getByTestId("anchored-link-landing").getByRole("heading", { level: 1 });
      await gotoOk(page, `/link/${link.id}?noredirect=1`);
      await expect(heading()).toHaveText(NAME);
      await gotoOk(page, `/links?doc=${sharedDoc.id}`);
      const creatorRow = linkRows(page).filter({ hasText: sharedDoc.title });
      const creatorField = creatorRow.getByRole("textbox", { name: "Link name" });
      await expect(creatorField).toHaveValue(NAME);
      await creatorField.fill("");
      await creatorField.press("Enter");
      await expect(creatorRow.locator("td").first()).toHaveCSS("border-left-color", SAVED);
      await gotoOk(page, `/link/${link.id}?noredirect=1`);
      await expect(heading()).toHaveText("Linked passages");
    } finally {
      await deleteTestAnchoredLink(link.id);
    }
  });

  test("the Owners dropdown offers only creators the viewer may list, filters by them, and has no Match select", async ({
    page,
    sharedDoc,
    secondUser,
  }) => {
    // docs/PERMISSIONS.md, "Review later — the Owners dropdown's disclosure":
    // the option list is the distinct creators of the rows this viewer may
    // list, not /files' every-eligible-user set. Two creators on the shared
    // doc make the admin's list; a third, whose only link points into their
    // own PRIVATE doc, must not appear — and naming their slug by hand in
    // ?owners= is dropped rather than honoured.
    const { user: author } = await secondUser({ role: "AUTHOR" });
    const { user: outsider } = await secondUser({ role: "AUTHOR" });
    const privateDoc = await createTestDoc({ authorEmail: outsider.email, bodyText: QUOTED_BODY });
    const byAdmin = await createTestAnchoredLink({
      creatorEmail: ADMIN_EMAIL,
      parts: [{ docId: sharedDoc.id, from: QUOTE_FROM, to: QUOTE_TO }],
    });
    const byAuthor = await createTestAnchoredLink({
      creatorEmail: author.email,
      parts: [{ docId: sharedDoc.id, from: QUOTE_FROM, to: QUOTE_TO }],
    });
    const hidden = await createTestAnchoredLink({
      creatorEmail: outsider.email,
      parts: [{ docId: privateDoc.id, from: QUOTE_FROM, to: QUOTE_TO }],
    });
    try {
      await gotoOk(page, `/links?doc=${sharedDoc.id}`);
      await expect(linkRows(page)).toHaveCount(2);

      await page.getByText(/^Owners: /).click();
      // Exact role queries: the row's own select box is labelled "Select link
      // by <name>", which a substring label match would also resolve to.
      const authorOption = page.getByRole("checkbox", { name: author.name, exact: true });
      await expect(authorOption).toBeVisible();
      await expect(page.getByText("E2E Admin (me)")).toBeVisible();
      await expect(page.getByRole("checkbox", { name: outsider.name, exact: true })).toHaveCount(0);
      // A link has one creator, so the panel renders no combining mode.
      await expect(page.getByLabel("Owner match mode")).toHaveCount(0);

      await authorOption.click();
      await expect(page).toHaveURL(new RegExp(`owners=${author.slug}`));
      await expect(linkRows(page)).toHaveCount(1);
      await expect(linkRows(page)).toContainText(author.name);
      // The summary names the person with no mode prefix ("ANY …" on /files).
      await expect(page.getByText(/^Owners: /)).toHaveText(`Owners: ${author.name}`);

      await page.getByRole("button", { name: "Clear owner filter" }).click();
      await expect(page).not.toHaveURL(/owners=/);
      await expect(linkRows(page)).toHaveCount(2);

      // Off the allowlist: the same two rows, not an empty table and not a
      // widened one.
      await gotoOk(page, `/links?doc=${sharedDoc.id}&owners=${outsider.slug}`);
      await expect(linkRows(page)).toHaveCount(2);
    } finally {
      await deleteTestAnchoredLink(hidden.id);
      await deleteTestAnchoredLink(byAuthor.id);
      await deleteTestAnchoredLink(byAdmin.id);
      await deleteTestDoc(privateDoc.id);
    }
  });

  test("a signed-out visitor's filters survive the sign-in redirect", async ({ browser }) => {
    // The kit's rule: the table's whole state is the querystring, so the
    // callbackUrl the gate writes has to carry it (CLAUDE.md, "Admin tables
    // are one kit"). A fresh, empty context — the gate answers "signed-out"
    // only to a visitor with no session at all.
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const visitor = await context.newPage();
    try {
      await visitor.goto("/links?q=abc&deleted=1");
      await visitor.waitForURL("**/sign-in?callbackUrl=*");
      expect(new URL(visitor.url()).searchParams.get("callbackUrl")).toBe("/links?q=abc&deleted=1");
    } finally {
      await context.close();
    }
  });
});
