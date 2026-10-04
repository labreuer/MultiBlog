import { test } from "node:test";
import assert from "node:assert/strict";
import { hasFilters, parseDay, parseSearchParams, searchQueryString, urlSearchParamsFrom, MAX_QUERY_LENGTH } from "./params";

// docs/FULLTEXT.md §6. The parser is the one reading of a search URL that
// the page and the API share, so what is worth pinning is what it refuses:
// anything malformed falls back to its default rather than reaching a query.

const parse = (query: string) => parseSearchParams(new URLSearchParams(query));

test("an empty querystring is every default", () => {
  assert.deepEqual(parse(""), {
    q: "",
    kinds: null,
    authors: [],
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
