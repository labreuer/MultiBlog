import { test, expect } from "./fixtures";
import { deleteTestReferences, getTestReference } from "./db";
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
