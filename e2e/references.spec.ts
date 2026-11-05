import { test, expect, bodyEditor, waitForDocCollabReady } from "./fixtures";
import {
  ADMIN_EMAIL,
  addTestDocAuthor,
  createTestDoc,
  createTestPost,
  deleteTestDoc,
  deleteTestPost,
  deleteTestReferences,
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

    // The reading view links it to the reference's page.
    await page.goto(`/doc/${doc.slug}`);
    await expect(page.locator("a.entity-chip").filter({ visible: true })).toHaveText([`(${short} p. 49)`]);
    await expect(page.locator("a.entity-chip").filter({ visible: true })).toHaveAttribute("href", `/references/${key}`);
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

    // A post holds it as linked text, to the reference's public page with the page cited.
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
      `/references/${key}#p=49`,
    );
    await expect(page.getByRole("link", { name: `Saving the Appearances ${prefix}`, exact: true }).filter({ visible: true })).toHaveAttribute(
      "href",
      `/references/${key}`,
    );
  } finally {
    await page.goto("about:blank");
    if (post) await deleteTestPost(post.id);
    await deleteTestDoc(doc.id);
    await deleteTestReferences(prefix);
    await agent.dispose();
  }
});

// docs/CITATIONS.md, "Markdown" — a citation written by a machine client in
// Pandoc's syntax, by key: read back as it was sent, changed by sending its
// Markdown with the change in it, and refused for a key the library lacks.
test("MCP writes citations in Pandoc's syntax, reads them back as sent, edits their pages, and refuses a key the library lacks", async ({ request }) => {
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

    // A note cites the same way, and its body can be replaced over a citation.
    const note = await agent.call("add_note", { on: url, quote: "appearances are collective", body: `Compare [@${radner}, p. 3].` });
    expect(note.isError, JSON.stringify(note.error)).toBe(false);
    const edited = await agent.call("edit_note", { id: String(note.result.id), body: `Compare [@${radner}, p. 4] and @${barfield}.` });
    expect(edited.isError, JSON.stringify(edited.error)).toBe(false);
    await expect.poll(() => getCitationSources(barfield)).toContain(`annotation:${note.result.id}`);

    // A key nothing has is refused, naming it, and nothing is created.
    const unknown = await agent.call("create_doc", { markdown: `Cite @${prefix}-nothing here.`, title: `Unknown ${prefix}` });
    expect(unknown.error).toMatchObject({ code: "unknown_chip", keys: [`${prefix}-nothing`] });
  } finally {
    for (const id of created) await deleteTestDoc(id);
    await deleteTestReferences(prefix);
    await agent.dispose();
  }
});
