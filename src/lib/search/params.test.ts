import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hasFilters,
  parseDay,
  parseSearchParams,
  searchQueryString,
  splitMentionTokens,
  urlSearchParamsFrom,
  MAX_QUERY_LENGTH,
} from "./params";

// docs/FULLTEXT.md §6. The parser is the one reading of a search URL that
// the page and the API share, so what is worth pinning is what it refuses:
// anything malformed falls back to its default rather than reaching a query.

const parse = (query: string) => parseSearchParams(new URLSearchParams(query));

test("an empty querystring is every default", () => {
  assert.deepEqual(parse(""), {
    q: "",
    kinds: null,
    authors: [],
    mentions: [],
    cites: [],
    citedTitle: "",
    citedAuthor: "",
    created: { from: null, to: null },
    updated: { from: null, to: null },
    tz: "UTC",
    page: 1,
    exact: false,
  });
  assert.equal(hasFilters(parse("")), false);
});

test("the text is trimmed and capped", () => {
  assert.equal(parse("q=%20%20Gödel%20%20").q, "Gödel");
  assert.equal(parse(`q=${"a".repeat(MAX_QUERY_LENGTH + 50)}`).q.length, MAX_QUERY_LENGTH);
});

test("kinds read comma-joined or repeated, in page order, unknown ones dropped", () => {
  assert.deepEqual(parse("kinds=comments,docs").kinds, ["docs", "comments"]);
  assert.deepEqual(parse("kinds=pdfs&kinds=posts").kinds, ["posts", "pdfs"]);
  assert.deepEqual(parse("kinds=docs,users,../etc").kinds, ["docs"]);
  // Nothing recognisable is the same as nothing named: every readable kind.
  assert.equal(parse("kinds=users").kinds, null);
  assert.equal(parse("kinds=").kinds, null);
});

test("author slugs must look like slugs, and repeat only once", () => {
  assert.deepEqual(parse("authors=ada-lovelace,grace,ada-lovelace").authors, ["ada-lovelace", "grace"]);
  assert.deepEqual(parse("authors=Ada,a%20b,-x,ok&authors=x_y").authors, ["ok"]);
});

test("a day must be a real calendar day in YYYY-MM-DD", () => {
  assert.equal(parseDay("2026-10-04"), "2026-10-04");
  assert.equal(parseDay("2024-02-29"), "2024-02-29");
  assert.equal(parseDay("2026-02-29"), null);
  assert.equal(parseDay("2026-13-01"), null);
  assert.equal(parseDay("2026-1-4"), null);
  assert.equal(parseDay("yesterday"), null);
  assert.equal(parseDay(""), null);
  assert.deepEqual(parse("created_from=2026-01-01&created_to=nope").created, { from: "2026-01-01", to: null });
  assert.equal(hasFilters(parse("updated_to=2026-01-01")), true);
});

test("an unknown time zone falls back to UTC", () => {
  assert.equal(parse("tz=America/New_York").tz, "America/New_York");
  assert.equal(parse("tz=Mars/Olympus_Mons").tz, "UTC");
  assert.equal(parse("tz=").tz, "UTC");
});

test("page is a positive integer, anything else is 1", () => {
  assert.equal(parse("page=3").page, 3);
  for (const bad of ["0", "-2", "1.5", "two", "1e3x"]) assert.equal(parse(`page=${bad}`).page, 1, bad);
});

test("exact is on only for exact=1", () => {
  assert.equal(parse("exact=1").exact, true);
  assert.equal(parse("exact=true").exact, false);
});

test("a querystring round-trips, keeping only what was chosen", () => {
  const query = "q=mediating+institutions&kinds=docs&authors=ada&created_from=2026-01-01&tz=Asia/Kolkata&page=2&exact=1";
  const params = parse(query);
  assert.deepEqual(parse(searchQueryString(params).slice(1)), params);
  assert.equal(searchQueryString(parse("")), "");
  // tz means something only beside a date, so it is dropped without one.
  assert.equal(searchQueryString(parse("q=x&tz=Asia/Kolkata")), "?q=x");
  // A change applies on top, as "All N docs" and pagination use it.
  assert.equal(searchQueryString(parse("q=x&page=4"), { kinds: ["docs"], page: 1 }), "?q=x&kinds=docs");
});

test("a page's resolved searchParams keep every value of a repeated name", () => {
  const params = urlSearchParamsFrom({ q: "x", kinds: ["docs", "pdfs"], page: undefined });
  assert.deepEqual(params.getAll("kinds"), ["docs", "pdfs"]);
  assert.deepEqual(parseSearchParams(params).kinds, ["docs", "pdfs"]);
  assert.equal(params.has("page"), false);
});

// docs/MENTIONS.md, "Search" — the mention filter: `mentions=`, and `@handle`
// typed into the box.

test("mention handles must look like slugs, me among them, and a filter by one is a filter", () => {
  assert.deepEqual(parse("mentions=me,ada-lovelace,me").mentions, ["me", "ada-lovelace"]);
  assert.deepEqual(parse("mentions=Ada,../x,@me").mentions, []);
  assert.equal(hasFilters(parse("mentions=me")), true);
  assert.equal(searchQueryString(parse("q=budget&mentions=me,ada")), "?q=budget&mentions=me%2Cada");
});

// docs/CITATIONS.md, "Search" — what cites a work, by its key, its title or its author.

test("cited-work filters: keys as a citation writes them, and text trimmed and capped", () => {
  assert.deepEqual(parse("cites=radner2012,@Barfield1957, radner2012,../x").cites, ["radner2012", "barfield1957"]);
  assert.equal(parse(`cited_title=%20${"a".repeat(150)}`).citedTitle.length, 100);
  for (const query of ["cites=radner2012", "cited_title=origin", "cited_author=radner"]) assert.equal(hasFilters(parse(query)), true, query);
  assert.equal(hasFilters(parse("cited_title=%20%20")), false);
  assert.equal(
    searchQueryString(parse("q=ideas&cites=radner2012&cited_title=The%20Origin&cited_author=radner")),
    "?q=ideas&cites=radner2012&cited_title=The+Origin&cited_author=radner",
  );
});

test("an @handle word in the box is a mention filter, and the rest is the text", () => {
  assert.deepEqual(splitMentionTokens("@me"), { mentions: ["me"], text: "" });
  assert.deepEqual(splitMentionTokens("the budget @ada-lovelace  for @Me and @ada-lovelace"), {
    mentions: ["ada-lovelace", "me"],
    text: "the budget for and",
  });
  // Every well-formed one, whether or not anyone has the handle: the box can't be used to ask who exists.
  assert.deepEqual(splitMentionTokens("@nobody-at-all").mentions, ["nobody-at-all"]);
});

test("an @ that isn't a word of its own names nobody", () => {
  for (const q of ["ada@example.com", "meet @ 5pm", "@-x", "@ada's draft", "(@ada)", "@ada.", "a@b @"]) {
    assert.deepEqual(splitMentionTokens(q), { mentions: [], text: q }, q);
  }
});
