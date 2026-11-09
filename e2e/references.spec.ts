import { test, expect, bodyEditor, waitForDocCollabReady } from "./fixtures";
import {
  ADMIN_EMAIL,
  addTestDocAuthor,
  createTestDoc,
  createTestFile,
  createTestPost,
  createTestUser,
  deleteTestDoc,
  deleteTestFile,
  deleteTestPost,
  deleteTestReferences,
  deleteTestUser,
  setTestReferenceFile,
  uniqueEmail,
  getCitationSources,
  getDocSearchText,
  getPostContentText,
  getReferenceId,
  getTestReference,
} from "./db";
import { createAgent } from "./mcp";

// docs/CITATIONS.md — the reference library: one record per work, recognised
// by its DOI and ISBNs, with a key that is permanent once used.

/** A valid ISBN-13 that no other run uses: a 978 prefix, nine digits from the clock, and its check digit. */
function freshIsbn(): string {
  const body = `978${String(Date.now() % 1_000_000_000).padStart(9, "0")}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(body[i]) * (i % 2 === 0 ? 1 : 3);
  return `${body}${(10 - (sum % 10)) % 10}`;
}

test("create_ref adds a work once: a second copy is refused by its ISBN, in either form, with the key to cite", async ({ request }) => {
  const agent = await createAgent(request);
  const reader = await createAgent(request, { scopes: ["READ"] });
  const prefix = `e2eref${Date.now().toString(36)}`;
  const isbn = freshIsbn();
  const book = {
    type: "book",
    title: `The Origin of Ideas ${prefix}`,
    author: [{ family: `Radner${prefix}`, given: "Daisie" }],
    issued: { "date-parts": [[2012]] },
    publisher: "Clarendon Press",
    "publisher-place": "Oxford",
    ISBN: isbn,
  };
  try {
    const created = await agent.call("create_ref", { csl: book, key: `${prefix}-radner2012`, short: "OI" });
    expect(created.isError, JSON.stringify(created.error)).toBe(false);
    expect(created.result).toMatchObject({
      key: `${prefix}-radner2012`,
      url: `/references/${prefix}-radner2012`,
      entry: `Radner${prefix}, D. (2012). The Origin of Ideas ${prefix}. Oxford: Clarendon Press.`,
    });
    expect(await getTestReference(`${prefix}-radner2012`)).toEqual({ key: `${prefix}-radner2012`, short: "OI", deleted: false, identifiers: [`ISBN:${isbn}`] });

    // The same book again, its ISBN hyphenated and under another title: the library says which record it is.
    const hyphenated = `${isbn.slice(0, 3)}-${isbn.slice(3, 4)}-${isbn.slice(4, 8)}-${isbn.slice(8, 12)}-${isbn.slice(12)}`;
    const again = await agent.call("create_ref", { csl: { ...book, title: "A reprint", ISBN: hyphenated }, key: `${prefix}-reprint` });
    expect(again.error).toMatchObject({ code: "duplicate", key: `${prefix}-radner2012`, url: `/references/${prefix}-radner2012` });
    expect(await getTestReference(`${prefix}-reprint`)).toBeNull();

    // An identifier that fails its check is refused, never stored.
    const bad = await agent.call("create_ref", { csl: { ...book, title: "Bad check digit", ISBN: `${isbn.slice(0, 12)}${(Number(isbn[12]) + 1) % 10}` } });
    expect(bad.error).toMatchObject({ code: "invalid" });
    // A chapter of that book carries the book's ISBN, and is its own record.
    const chapter = await agent.call("create_ref", {
      csl: { type: "chapter", title: `A Chapter ${prefix}`, author: [{ family: "Lewis", given: "C. S." }], "container-title": book.title, ISBN: isbn, page: "49-51" },
      key: `${prefix}-lewis`,
    });
    expect(chapter.isError, JSON.stringify(chapter.error)).toBe(false);
    expect(chapter.result.entry).toBe(`Lewis, C. S. (n.d.). “A Chapter ${prefix}.” In The Origin of Ideas ${prefix}, pp. 49–51.`);
    // A key somebody has is not handed out twice.
    const taken = await agent.call("create_ref", { csl: { type: "book", title: "Another work entirely" }, key: `${prefix}-lewis` });
    expect(taken.error).toMatchObject({ code: "conflict" });
    // With no key given, one is made from the author and the year.
    const keyed = await agent.call("create_ref", {
      csl: { type: "book", title: "Keyed by its author", author: [{ family: `E2e ${prefix}` }], issued: { "date-parts": [[1957]] } },
    });
    expect(keyed.result.key).toBe(`e2e${prefix}1957`);

    // Found by a word of the title still being typed, by an author's name, and by its ISBN in any form.
    for (const query of [`origin ${prefix.slice(0, 8)}`, `Radner${prefix}`, hyphenated]) {
      const found = await reader.call("find_refs", { query });
      expect((found.result.references as { key: string }[]).map((r) => r.key), query).toContain(`${prefix}-radner2012`);
    }
    const none = await reader.call("find_refs", { query: `nothing-called-this-${prefix}` });
    expect(none.result.references).toEqual([]);
  } finally {
    await deleteTestReferences(prefix);
    await deleteTestReferences(`e2e${prefix}`);
    await agent.dispose();
    await reader.dispose();
  }
});

test("the library's page: pasted BibTeX is imported once, listed, and a second paste says what is already there", async ({ page, browser }) => {
  const prefix = `e2eui${Date.now().toString(36)}`;
  const isbn = freshIsbn();
  const bibtex = `
    @book{${prefix}-barfield1957,
      author = {Barfield, Owen},
      title = {Saving the Appearances ${prefix}},
      publisher = {Faber},
      address = {London},
      year = {1957},
      isbn = {${isbn}}
    }
    @article{${prefix}-noauthor,
      title = {An Anonymous Note ${prefix}},
      journal = {Mind},
      year = 1960,
      pages = {1--3}
    }
    @book{${prefix}-untitled, author = {Nobody, N.}, year = 2000 }`;
  try {
    await page.goto("/references");
    await page.getByText("Add references").click();
    await page.getByRole("textbox", { name: "References to import" }).fill(bibtex);
    await page.getByRole("button", { name: "Import" }).click();
    const report = page.getByRole("list", { name: "Import results" });
    await expect(report).toContainText(`Added ${prefix}-barfield1957: Saving the Appearances ${prefix}`);
    await expect(report).toContainText(`Added ${prefix}-noauthor`);
    // The one with no title is refused by name, and left in the box to be corrected.
    await expect(report).toContainText("A reference needs a title.");
    expect(await getTestReference(`${prefix}-barfield1957`)).toMatchObject({ identifiers: [`ISBN:${isbn}`], deleted: false });

    // The table lists it, found by a word of its title, with the columns read from its record.
    await page.goto(`/references?q=${prefix}`);
    const row = page.getByRole("row").filter({ hasText: `${prefix}-barfield1957` });
    await expect(row).toContainText("Barfield Owen");
    await expect(row).toContainText("1957");
    await expect(row).toContainText(`Saving the Appearances ${prefix}`);

    // The same record pasted again is not a second copy.
    await page.getByText("Add references").click();
    await page.getByRole("textbox", { name: "References to import" }).fill(bibtex.split("@article")[0]);
    await page.getByRole("button", { name: "Import" }).click();
    await expect(page.getByRole("list", { name: "Import results" })).toContainText(`Already in the library as ${prefix}-barfield1957`);

    // Its own page is public: a signed-out reader gets the entry, as a published post's citation will link to it.
    const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const visitor = await anonymous.newPage();
    const response = await visitor.goto(`/references/${prefix}-barfield1957`);
    expect(response?.status()).toBe(200);
    await expect(visitor.getByRole("heading", { level: 1 })).toHaveText(`Saving the Appearances ${prefix}`);
    await expect(visitor.getByRole("main")).toContainText(`Barfield, O. (1957). Saving the Appearances ${prefix}. London: Faber.`);
    // And the list is not: it is the members' table.
    await visitor.goto("/references");
    await expect(visitor).toHaveURL(/\/sign-in\?/);

    // Renaming the key leaves the old one answering.
    page.once("dialog", (dialog) => void dialog.accept(`${prefix}-barfield-appearances`));
    await page.goto(`/references?q=${prefix}`);
    await page.getByRole("button", { name: `Rename key ${prefix}-barfield1957` }).click();
    await expect(page.getByRole("link", { name: `${prefix}-barfield-appearances` })).toBeVisible();
    await visitor.goto(`/references/${prefix}-barfield1957`);
    await expect(visitor).toHaveURL(new RegExp(`/references/${prefix}-barfield-appearances$`));
    await anonymous.close();
  } finally {
    await page.goto("about:blank");
    await deleteTestReferences(prefix);
  }
});

// docs/CITATIONS.md — the citation chip: a work at a page, inserted from the
// library by "[@", labelled from the reference's record wherever it is shown.
test("[@ cites a work from the library: the chip is labelled, listed in the bibliography, indexed, published as a link, and follows the reference", async ({
  page,
  request,
}) => {
  const agent = await createAgent(request);
  const prefix = `e2ecite${Date.now().toString(36)}`;
  const short = `B${Date.now() % 100000}`;
  const key = `${prefix}-barfield1957`;
  const doc = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: "Appearances are collective representations." });
  await addTestDocAuthor(doc.id, agent.user.email);
  let post: Awaited<ReturnType<typeof createTestPost>> | null = null;
  try {
    const made = await agent.call("create_ref", {
      csl: { type: "book", title: `Saving the Appearances ${prefix}`, author: [{ family: `Barfield${prefix}`, given: "Owen" }], issued: { "date-parts": [[1957]] } },
      key,
      short,
    });
    expect(made.isError, JSON.stringify(made.error)).toBe(false);
    const refId = (await getReferenceId(key))!;

    await page.goto(`/doc/${doc.id}/edit`);
    await waitForDocCollabReady(page);
    await bodyEditor(page).click();
    await page.keyboard.press("Control+End");
    // The work by a word of its author's name, and the page after it.
    await page.keyboard.type(` [@Barfield${prefix} 49`);
    const option = page.getByRole("listbox", { name: "References" }).getByRole("option").first();
    await expect(option).toContainText(`Saving the Appearances ${prefix}`);
    await page.keyboard.press("Enter");

    // Labelled as it lands, in the doc's style: the abbreviation and the page.
    const chip = bodyEditor(page).locator(".entity-chip");
    await expect(chip).toHaveText([`(${short} p. 49)`]);
    // The bibliography follows the text, inside the editor's scrolling box, leading with what the label calls the work.
    const entryOf = (lead: string) => `${lead}Barfield${prefix}, O. (1957). Saving the Appearances ${prefix}.`;
    const bibliography = page.locator("[data-editor-scroll] [data-bibliography]").getByRole("listitem");
    await expect(bibliography).toHaveText([entryOf(`${short} `)]);
    // The doc's own style changes every citation's label at once, delimiters and all, and the bibliography with them.
    await page.locator("[data-doc-settings] > summary").click();
    await page.getByRole("combobox", { name: "How citations are shown" }).selectOption("numeric");
    await expect(chip).toHaveText(["[1, p. 49]"]);
    await expect(bibliography).toHaveText([entryOf("[1] ")]);
    await page.getByRole("combobox", { name: "How citations are shown" }).selectOption("author-date");
    await expect(chip).toHaveText([`(Barfield${prefix} 1957, p. 49)`]);
    await expect(bibliography).toHaveText([entryOf("")]);
    await page.getByRole("combobox", { name: "How citations are shown" }).selectOption("short");
    await expect(chip).toHaveText([`(${short} p. 49)`]);
    // What search reads, and where the work is now cited.
    await expect.poll(() => getDocSearchText(doc.id), { timeout: 15_000 }).toContain(`representations. (${short} p. 49)`);
    await expect.poll(() => getCitationSources(key)).toEqual([`doc:${doc.id}`]);

    // The reading view links it to the route that decides, when it is followed, where page 49 is for this reader.
    await page.goto(`/doc/${doc.slug}`);
    await expect(page.locator("a.entity-chip").filter({ visible: true })).toHaveText([`(${short} p. 49)`]);
    await expect(page.locator("a.entity-chip").filter({ visible: true })).toHaveAttribute("href", `/references/${key}/p/49`);
    const shown = page.locator("[data-bibliography]").filter({ visible: true });
    await expect(shown.getByRole("listitem")).toHaveText([entryOf(`${short} `)]);
    await expect(shown.getByRole("link", { name: `Saving the Appearances ${prefix}` })).toHaveAttribute("href", `/references/${key}`);

    // A machine reader gets Pandoc's syntax, by key, and can write a passage over it back.
    const read = await agent.call("read", { url: `/doc/${doc.slug}` });
    expect(String(read.result.markdown)).toContain(`[@${key}, p. 49]`);
    const over = await agent.call("edit_doc", {
      url: `/doc/${doc.slug}`,
      edits: [{ old: `representations. (${short} p. 49)`, new: `representations [@${key}, p. 49].` }],
    });
    expect(over.isError, JSON.stringify(over.error)).toBe(false);
    const beside = await agent.call("edit_doc", { url: `/doc/${doc.slug}`, edits: [{ old: "Appearances are", new: "Appearances, he says, are" }] });
    expect(beside.isError, JSON.stringify(beside.error)).toBe(false);
    expect(await getCitationSources(key)).toEqual([`doc:${doc.id}`]);

    // Correcting the reference relabels the doc with nobody opening it.
    await page.goto(`/references?q=${prefix}`);
    page.once("dialog", (dialog) => void dialog.accept(`${short}X`));
    await page.getByRole("button", { name: `Set abbreviation of ${key}` }).click();
    await expect.poll(() => getDocSearchText(doc.id), { timeout: 15_000 }).toContain(`(${short}X p. 49)`);

    // A post holds it as linked text, to the same route.
    post = await createTestPost({
      authorEmail: ADMIN_EMAIL,
      publish: true,
      body: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "As argued " },
              { type: "entityChip", attrs: { kind: "citation", iid: "c1", data: { items: [{ refId, locator: "49–51" }] } } },
              { type: "text", text: "." },
            ],
          },
        ],
      },
    });
    // Its bibliography is text too, appended at publish.
    expect(await getPostContentText(post.id)).toBe(`As argued (${short}X pp. 49–51).\n\nReferences\n\n${entryOf(`${short}X `)}`);
    await expect.poll(() => getCitationSources(key)).toEqual([`doc:${doc.id}`, `doc:${post!.docId}`, `post:${post!.id}`].sort());
    const response = await page.goto(post.path!);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("link", { name: `(${short}X pp. 49–51)`, exact: true }).filter({ visible: true })).toHaveAttribute(
      "href",
      `/references/${key}/p/49`,
    );
    await expect(page.getByRole("link", { name: `Saving the Appearances ${prefix}`, exact: true }).filter({ visible: true })).toHaveAttribute(
      "href",
      `/references/${key}`,
    );

    // The reference's page lists the published posts citing it for everyone, and the docs only to whoever may read them.
    await page.goto(`/references/${key}#p=49`);
    await expect(page.locator("section", { hasText: "Cited in posts" }).getByRole("link", { name: post.title })).toBeVisible();
    const citedBy = page.getByRole("region", { name: "Where you can read it" });
    await expect(citedBy.locator(`a[href="/doc/${doc.slug}"]`)).toBeVisible();
    await expect(citedBy.getByRole("link", { name: "Search what cites it" })).toHaveAttribute("href", `/search?cites=${key}`);
    const anonymous = await page.context().browser()!.newContext({ storageState: { cookies: [], origins: [] } });
    try {
      const outsider = await anonymous.newPage();
      await outsider.goto(`/references/${key}`);
      await expect(outsider.getByRole("link", { name: post.title })).toBeVisible();
      await expect(outsider.getByRole("region", { name: "Where you can read it" })).toHaveCount(0);
      await expect(outsider.locator(`a[href="/doc/${doc.slug}"]`)).toHaveCount(0);
    } finally {
      await anonymous.close();
    }
  } finally {
    await page.goto("about:blank");
    if (post) await deleteTestPost(post.id);
    await deleteTestDoc(doc.id);
    await deleteTestReferences(prefix);
    await agent.dispose();
  }
});

// docs/CITATIONS.md, "The link" — a citation's link at a page is one route for
// every reader, which decides when it is followed: the PDF at that page for a
// reader who may open the work's PDF, the reference's page for anyone else.
test("a citation's link at a page sends a reader who may open the work's PDF to that page, and anyone else to the reference's page", async ({
  page,
  browser,
  request,
}) => {
  const agent = await createAgent(request);
  const prefix = `e2eroute${Date.now().toString(36)}`;
  const key = `${prefix}-bhaskar1975`;
  const other = await createTestUser({ email: uniqueEmail("route-owner"), role: "AUTHOR" });
  const files: string[] = [];
  try {
    const made = await agent.call("create_ref", {
      csl: { type: "book", title: `A Realist Theory of Science ${prefix}`, author: [{ family: `Bhaskar${prefix}` }], issued: { "date-parts": [[1975]] } },
      key,
    });
    expect(made.isError, JSON.stringify(made.error)).toBe(false);
    // Test PDFs carry no page labels, so a page is the sheet: these have two.
    const shared = await createTestFile({ ownerEmail: ADMIN_EMAIL, visibility: "SHARED" });
    const mine = await createTestFile({ ownerEmail: ADMIN_EMAIL, visibility: "PRIVATE" });
    const theirs = await createTestFile({ ownerEmail: other.email, visibility: "PRIVATE" });
    files.push(shared.id, mine.id, theirs.id);
    const home = `/references/${key}`;
    const follow = async (at: string): Promise<string> => {
      const response = await page.goto(at);
      expect(response?.status()).toBeLessThan(400);
      const url = new URL(page.url());
      return `${url.pathname}${url.hash}`;
    };

    // With no PDF, everyone goes to the reference's page, the page cited in the fragment for its island.
    expect(await follow(`${home}/p/2`)).toBe(`${home}#p=2`);
    // A shared PDF, at the page cited; a page it doesn't have, and a locator that is no page, go to the reference.
    await setTestReferenceFile(key, shared.id);
    expect(await follow(`${home}/p/2`)).toBe(`/pdf/${shared.slug}#page=2`);
    expect(await follow(`${home}/p/3`)).toBe(`${home}#p=3`);
    expect(await follow(`${home}/p/${encodeURIComponent("ch. 3")}`)).toBe(home);
    // A private PDF reaches its owner from the same link, and nobody else.
    await setTestReferenceFile(key, mine.id);
    expect(await follow(`${home}/p/2`)).toBe(`/pdf/${mine.slug}#page=2`);
    await setTestReferenceFile(key, theirs.id);
    expect(await follow(`${home}/p/2`)).toBe(`${home}#p=2`);
    // Signed out, a shared PDF is still not readable: the reference's page, as for no PDF at all.
    await setTestReferenceFile(key, shared.id);
    const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    try {
      const outsider = await anonymous.newPage();
      await outsider.goto(`${home}/p/2`);
      const url = new URL(outsider.url());
      expect(`${url.pathname}${url.hash}`).toBe(`${home}#p=2`);
    } finally {
      await anonymous.close();
    }
    // A key nothing has is not found.
    expect((await page.goto(`/references/${prefix}-nobody/p/2`))?.status()).toBe(404);
  } finally {
    await page.goto("about:blank");
    await deleteTestReferences(prefix);
    for (const id of files) await deleteTestFile(id);
    await deleteTestUser(other.email);
    await agent.dispose();
  }
});

// docs/CITATIONS.md, "A work's PDF" — tied from the PDF's own page, where you
// are after uploading it, and then followed from a citation at a page.
test("a PDF's Metadata pane ties it to a reference, and a citation of the work at a page opens that page", async ({ page, request }) => {
  const agent = await createAgent(request);
  const prefix = `e2etie${Date.now().toString(36)}`;
  const key = `${prefix}-bhaskar1975`;
  const title = `A Realist Theory of Science ${prefix}`;
  const file = await createTestFile({ ownerEmail: ADMIN_EMAIL, visibility: "PRIVATE" });
  let docId = "";
  try {
    const made = await agent.call("create_ref", { csl: { type: "book", title, author: [{ family: `Bhaskar${prefix}` }], issued: { "date-parts": [[1975]] } }, key });
    expect(made.isError, JSON.stringify(made.error)).toBe(false);

    await page.goto(`/pdf/${file.slug}`);
    await page.getByRole("tab", { name: "Metadata" }).click();
    const panel = page.getByRole("region", { name: "The PDF of" });
    await expect(panel).toContainText("No reference in the library names this as its PDF.");
    // A private PDF says who a citation opens it for.
    await expect(panel).toContainText("This PDF is private, so a citation of it opens it only for people who may read it.");
    await panel.getByLabel("Add a reference").fill(`Bhaskar${prefix}`);
    await panel.getByRole("button", { name: new RegExp(title) }).click();
    await expect(panel.getByRole("link", { name: new RegExp(title) })).toHaveAttribute("href", `/references/${key}`);

    // A doc citing the work at page 2 opens the PDF there for its owner, who may read it.
    const doc = await agent.call("create_doc", { markdown: `Realism about structures [@${key}, p. 2].`, title: `Tie ${prefix}` });
    expect(doc.isError, JSON.stringify(doc.error)).toBe(false);
    docId = String(doc.result.id);
    await page.goto(`/doc/${docId}`);
    const chip = page.locator("a.entity-chip").filter({ visible: true });
    await expect(chip).toHaveAttribute("href", `/references/${key}/p/2`);
    await page.goto(`/references/${key}/p/2`);
    await expect(page).toHaveURL(`/pdf/${file.slug}#page=2`);

    // Removing it unties it, and the list says so.
    await page.getByRole("tab", { name: "Metadata" }).click();
    await page.getByRole("button", { name: `Untie ${key} from this PDF` }).click();
    await expect(page.getByRole("region", { name: "The PDF of" })).toContainText("No reference in the library names this as its PDF.");
  } finally {
    await page.goto("about:blank");
    if (docId) await deleteTestDoc(docId);
    await deleteTestReferences(prefix);
    await deleteTestFile(file.id);
    await agent.dispose();
  }
});

// docs/CITATIONS.md, "A work's PDF" — the File column of /references: set and
// removed by a writer, and named only to a viewer who may read it.
test("the File column of /references sets a reference's PDF, removes it, and names only a PDF the viewer may read", async ({ page, request }) => {
  const agent = await createAgent(request);
  const prefix = `e2efilecol${Date.now().toString(36)}`;
  const key = `${prefix}-barfield1957`;
  const other = await createTestUser({ email: uniqueEmail("filecol-owner"), role: "AUTHOR" });
  const mine = await createTestFile({ ownerEmail: ADMIN_EMAIL, visibility: "SHARED", title: `Saving the Appearances scan ${prefix}` });
  const theirs = await createTestFile({ ownerEmail: other.email, visibility: "PRIVATE", title: `Their private scan ${prefix}` });
  try {
    const made = await agent.call("create_ref", {
      csl: { type: "book", title: `Saving the Appearances ${prefix}`, author: [{ family: `Barfield${prefix}` }], issued: { "date-parts": [[1957]] } },
      key,
    });
    expect(made.isError, JSON.stringify(made.error)).toBe(false);
    const row = () => page.getByRole("row").filter({ hasText: key });

    await page.goto(`/references?q=${prefix}`);
    await row().getByRole("button", { name: `Set PDF of ${key}` }).click();
    await row().getByLabel(`The PDF of ${key}`).fill(prefix);
    // Only PDFs this viewer may read are offered.
    await expect(row().getByRole("button", { name: mine.title })).toBeVisible();
    await expect(row().getByRole("button", { name: theirs.title })).toHaveCount(0);
    await row().getByRole("button", { name: mine.title }).click();
    await expect(row().getByRole("link", { name: mine.title })).toHaveAttribute("href", `/pdf/${mine.slug}`);

    await row().getByRole("button", { name: `Set PDF of ${key}` }).click();
    await row().getByRole("button", { name: "Remove the PDF" }).click();
    await expect(row().getByRole("link", { name: mine.title })).toHaveCount(0);

    // A PDF the viewer may not read is shown as one, unnamed.
    await setTestReferenceFile(key, theirs.id);
    await page.reload();
    await expect(row()).toContainText("a PDF you can't open");
    await expect(row()).not.toContainText(theirs.title);
  } finally {
    await page.goto("about:blank");
    await deleteTestReferences(prefix);
    await deleteTestFile(mine.id);
    await deleteTestFile(theirs.id);
    await deleteTestUser(other.email);
    await agent.dispose();
  }
});

// docs/CITATIONS.md, "MCP" — create_ref ties the work to a PDF the account may
// read, and find_refs names it, to that account only.
test("create_ref ties a work to a PDF the account may read, refuses one it may not, and find_refs names the PDF", async ({ request }) => {
  const agent = await createAgent(request);
  const prefix = `e2erefpdf${Date.now().toString(36)}`;
  const other = await createTestUser({ email: uniqueEmail("refpdf-owner"), role: "AUTHOR" });
  // Shared, so the agent's own account may read it; the other is another account's private PDF.
  const mine = await createTestFile({ ownerEmail: ADMIN_EMAIL, visibility: "SHARED" });
  const theirs = await createTestFile({ ownerEmail: other.email, visibility: "PRIVATE" });
  try {
    const csl = (name: string) => ({ type: "book", title: `${name} ${prefix}`, author: [{ family: `${name}${prefix}` }], issued: { "date-parts": [[1990]] } });
    const tied = await agent.call("create_ref", { csl: csl("Mine"), key: `${prefix}-mine1990`, file: `/pdf/${mine.slug}` });
    expect(tied.isError, JSON.stringify(tied.error)).toBe(false);
    const refused = await agent.call("create_ref", { csl: csl("Theirs"), key: `${prefix}-theirs1990`, file: `/pdf/${theirs.slug}` });
    expect(refused.isError).toBe(true);
    expect(refused.error.code).toBe("not_found");
    const found = await agent.call("find_refs", { query: `Mine${prefix}` });
    expect(found.isError, JSON.stringify(found.error)).toBe(false);
    expect(found.result.references).toEqual([expect.objectContaining({ key: `${prefix}-mine1990`, pdf: `/pdf/${mine.slug}` })]);
  } finally {
    await deleteTestReferences(prefix);
    await deleteTestFile(mine.id);
    await deleteTestFile(theirs.id);
    await deleteTestUser(other.email);
    await agent.dispose();
  }
});

// docs/CITATIONS.md, "Markdown" — a citation written by a machine client in
// Pandoc's syntax, by key: read back as it was sent, changed by sending its
// Markdown with the change in it, and refused for a key the library lacks.
test("MCP writes citations in Pandoc's syntax, reads them back as sent, edits their pages, finds them by a quote in it, finds what cites a work, and refuses a key the library lacks", async ({
  page,
  request,
}) => {
  const agent = await createAgent(request);
  const prefix = `e2ecm${Date.now().toString(36)}`;
  const short = `S${Date.now() % 100000}`;
  const radner = `${prefix}-radner2012`;
  const barfield = `${prefix}-barfield1957`;
  const created: string[] = [];
  try {
    for (const [key, csl, abbreviation] of [
      [radner, { type: "book", title: `The Origin of Ideas ${prefix}`, author: [{ family: `Radner${prefix}` }], issued: { "date-parts": [[2012]] } }, undefined],
      [barfield, { type: "book", title: `Saving the Appearances ${prefix}`, author: [{ family: `Barfield${prefix}` }], issued: { "date-parts": [[1957]] } }, short],
    ] as const) {
      const made = await agent.call("create_ref", { csl, key, ...(abbreviation ? { short: abbreviation } : {}) });
      expect(made.isError, JSON.stringify(made.error)).toBe(false);
    }

    // Narrative and parenthetical, a prefix and pages, and an @ written as text.
    const markdown = `As @${radner} [p. 49] argues, appearances are collective [see @${barfield}, p. 12]. Write \\@${radner} to name the key.`;
    const doc = await agent.call("create_doc", { markdown, title: `Citations ${prefix}` });
    expect(doc.isError, JSON.stringify(doc.error)).toBe(false);
    created.push(String(doc.result.id));
    const url = String(doc.result.url);
    await expect.poll(() => getCitationSources(radner)).toEqual([`doc:${doc.result.id}`]);
    await expect.poll(() => getCitationSources(barfield)).toEqual([`doc:${doc.result.id}`]);
    // A read sends back what was written; a text read shows the labels.
    expect((await agent.call("read", { url })).result.markdown).toBe(markdown);
    const text = String((await agent.call("read", { url, format: "text" })).result.text ?? "");
    expect(text).toContain(`As Radner${prefix} (2012, p. 49) argues, appearances are collective (see ${short} p. 12).`);

    // The citation's Markdown sent with a new page and a second work: the same chip, edited.
    const edit = await agent.call("edit_doc", { url, edits: [{ old: `collective (see ${short} p. 12)`, new: `collective [see @${barfield}, p. 13; @${radner}]` }] });
    expect(edit.isError, JSON.stringify(edit.error)).toBe(false);
    expect((await agent.call("read", { url })).result.markdown).toContain(`collective [see @${barfield}, p. 13; @${radner}].`);

    // A quote may give a citation as its Markdown: found by the works it cites, and an
    // edit from a stale read, naming another page, is refused with the citation now.
    const now = `[see @${barfield}, p. 13; @${radner}]`;
    const around = await agent.call("read", { url, around: `collective ${now}` });
    expect(around.isError, JSON.stringify(around.error)).toBe(false);
    expect(around.result).toMatchObject({ total: 1, matchedAs: "markdown" });
    const stale = await agent.call("read", { url, around: `collective [see @${barfield}, p. 12; @${radner}]` });
    expect((stale.result.occurrences as { chipsNow?: string[] }[])[0].chipsNow).toEqual([now]);
    const refused = await agent.call("edit_doc", { url, edits: [{ old: `collective [see @${barfield}, p. 12; @${radner}]`, new: "collective" }] });
    expect(refused.error).toMatchObject({ code: "chip_changed", chips: [now] });
    const repaged = await agent.call("edit_doc", { url, edits: [{ old: `collective ${now}`, new: `collective [see @${barfield}, p. 14; @${radner}]` }] });
    expect(repaged.isError, JSON.stringify(repaged.error)).toBe(false);
    expect((await agent.call("read", { url })).result.markdown).toContain(`collective [see @${barfield}, p. 14; @${radner}].`);
    // A note on it from the stale read lands all the same, and is told the page now.
    const asked = await agent.call("add_note", { on: url, quote: `collective ${now}`, body: "Which page?" });
    expect(asked.isError, JSON.stringify(asked.error)).toBe(false);
    expect((asked.result.passage as { chipsNow?: string[] }).chipsNow).toEqual([`[see @${barfield}, p. 14; @${radner}]`]);

    // A note cites the same way, and its body can be replaced over a citation.
    const note = await agent.call("add_note", { on: url, quote: "appearances are collective", body: `Compare [@${radner}, p. 3].` });
    expect(note.isError, JSON.stringify(note.error)).toBe(false);
    const edited = await agent.call("edit_note", { id: String(note.result.id), body: `Compare [@${radner}, p. 4] and @${barfield}.` });
    expect(edited.isError, JSON.stringify(edited.error)).toBe(false);
    await expect.poll(() => getCitationSources(barfield)).toContain(`annotation:${note.result.id}`);

    // What cites a work: by its key, a word of its title, or its author's name, each filter at once.
    type Found = { sections: { kind: string; hits: { url?: string; id?: string }[] }[]; withoutCitations?: string[] };
    const found = async (args: Record<string, unknown>) => {
      const answer = await agent.call("search", args);
      expect(answer.isError, JSON.stringify(answer.error)).toBe(false);
      const result = answer.result as unknown as Found;
      return Object.fromEntries(result.sections.map((section) => [section.kind, section.hits.map((hit) => hit.url ?? hit.id)]));
    };
    expect(await found({ cites: [barfield], kinds: ["docs", "annotations"] })).toEqual({ docs: [url], annotations: [String(note.result.id)] });
    expect(await found({ cited_title: `origin ${prefix}`, kinds: ["docs"] })).toEqual({ docs: [url] });
    expect(await found({ cited_author: `Barfield${prefix}`, cites: [radner], kinds: ["docs"] })).toEqual({ docs: [url] });
    // Every filter at once: nothing cites a work titled so.
    expect(await found({ cited_author: `Barfield${prefix}`, cited_title: `nowhere ${prefix}`, kinds: ["docs"] })).toEqual({ docs: [] });
    const comments = await agent.call("search", { cites: [radner], kinds: ["docs", "comments"] });
    expect((comments.result as unknown as Found).withoutCitations).toEqual(["comments"]);
    const unknownKey = await agent.call("search", { cites: [`${prefix}-nothing`] });
    expect(unknownKey.error).toMatchObject({ code: "invalid", keys: [`${prefix}-nothing`] });
    // The page reads the same filter, and says what it narrows to.
    await page.goto(`/search?cites=${barfield}`);
    await expect(page.getByText(`Only what cites @${barfield}`)).toBeVisible();
    await expect(page.getByRole("link", { name: `Citations ${prefix}`, exact: true })).toBeVisible();

    // A key nothing has is refused, naming it, and nothing is created.
    const unknown = await agent.call("create_doc", { markdown: `Cite @${prefix}-nothing here.`, title: `Unknown ${prefix}` });
    expect(unknown.error).toMatchObject({ code: "unknown_chip", keys: [`${prefix}-nothing`] });
  } finally {
    for (const id of created) await deleteTestDoc(id);
    await deleteTestReferences(prefix);
    await agent.dispose();
  }
});

// docs/CITATIONS.md, "The popover" — what a citation says beyond which works,
// edited in place: each field one attribute set on the chip, so it keeps its
// instance id and the bibliography follows.
test("a citation's popover edits its page, the words before it, its form and its works", async ({ page, request }) => {
  const agent = await createAgent(request);
  const prefix = `e2epop${Date.now().toString(36)}`;
  const short = `P${Date.now() % 100000}`;
  const barfield = `${prefix}-barfield1957`;
  const radner = `${prefix}-radner2012`;
  let docId = "";
  try {
    for (const [key, csl, abbreviation] of [
      [barfield, { type: "book", title: `Saving the Appearances ${prefix}`, author: [{ family: `Barfield${prefix}` }], issued: { "date-parts": [[1957]] } }, short],
      [radner, { type: "book", title: `The Origin of Ideas ${prefix}`, author: [{ family: `Radner${prefix}` }], issued: { "date-parts": [[2012]] } }, undefined],
    ] as const) {
      const made = await agent.call("create_ref", { csl, key, ...(abbreviation ? { short: abbreviation } : {}) });
      expect(made.isError, JSON.stringify(made.error)).toBe(false);
    }
    const doc = await agent.call("create_doc", { markdown: `Appearances are collective [@${barfield}, p. 49].`, title: `Popover ${prefix}` });
    expect(doc.isError, JSON.stringify(doc.error)).toBe(false);
    docId = String(doc.result.id);

    await page.goto(`/doc/${docId}/edit`);
    await waitForDocCollabReady(page);
    const chip = bodyEditor(page).locator(".entity-chip");
    await expect(chip).toHaveText([`(${short} p. 49)`]);
    const iid = await chip.getAttribute("data-iid");

    // Selecting the chip opens its popover; a field writes on Enter, or when it is left.
    await chip.click();
    const popover = page.locator(`[data-cite-popover="${iid}"]`);
    const work = popover.getByRole("group", { name: barfield });
    await work.getByLabel("Page").fill("50-52");
    await work.getByLabel("Page").press("Enter");
    await expect(chip).toHaveText([`(${short} pp. 50–52)`]);
    await work.getByLabel("Before").fill("see");
    await work.getByLabel("After").focus();
    await expect(chip).toHaveText([`(see ${short} pp. 50–52)`]);
    await work.getByLabel("Leave out the author").check();
    await expect(chip).toHaveText(["(see pp. 50–52)"]);
    // In the sentence holds one work with its author shown and nothing before it.
    await expect(popover.getByLabel("In the sentence")).toBeDisabled();
    await work.getByLabel("Leave out the author").uncheck();
    await work.getByLabel("Before").fill("");
    await work.getByLabel("Before").press("Enter");
    await popover.getByLabel("In the sentence").check();
    await expect(chip).toHaveText([`${short} (pp. 50–52)`]);
    await popover.getByLabel("In parentheses").check();

    // A second work, by a word of its author's name and a page, as the [@ menu finds one.
    await popover.getByLabel("Add a work").fill(`Radner${prefix} 7`);
    await popover.getByRole("button", { name: new RegExp(`The Origin of Ideas ${prefix}`) }).click();
    await expect(chip).toHaveText([`(${short} pp. 50–52; Radner${prefix} 2012, p. 7)`]);
    await expect(page.locator("[data-editor-scroll] [data-bibliography]").getByRole("listitem")).toHaveCount(2);
    await popover.getByRole("button", { name: `Remove ${radner}` }).click();
    await expect(chip).toHaveText([`(${short} pp. 50–52)`]);
    await expect(page.locator("[data-editor-scroll] [data-bibliography]").getByRole("listitem")).toHaveCount(1);
    // The same chip throughout.
    await expect(chip).toHaveAttribute("data-iid", iid!);

    // Page holds pages only: what follows them goes after the work, and the popover says so.
    await work.getByLabel("Page").fill("49 n. 3");
    await work.getByLabel("Page").press("Enter");
    await expect(chip).toHaveText([`(${short} p. 49, n. 3)`]);
    await expect(work.getByLabel("Page")).toHaveValue("49");
    await expect(work.getByLabel("After")).toHaveValue("n. 3");
    await expect(work.getByRole("status")).toHaveText("Page holds page numbers only, so “n. 3” went to After.");

    // Escape goes back to the editor with the chip still selected, and Enter comes back in.
    await page.keyboard.press("Escape");
    await expect(popover).toBeVisible();
    await expect(bodyEditor(page)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(work.getByLabel("Page")).toBeFocused();
    // Clicking elsewhere in the text closes it.
    await bodyEditor(page).getByText("Appearances are").click();
    await expect(popover).toBeHidden();

    // What was written reaches the server, once the collab server has stored it.
    await expect
      .poll(async () => String((await agent.call("read", { url: `/doc/${docId}` })).result.markdown), { timeout: 15_000 })
      .toBe(`Appearances are collective [@${barfield}, p. 49, n. 3].`);
  } finally {
    await page.goto("about:blank");
    if (docId) await deleteTestDoc(docId);
    await deleteTestReferences(prefix);
    await agent.dispose();
  }
});
