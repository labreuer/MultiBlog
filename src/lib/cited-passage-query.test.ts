import { test } from "node:test";
import assert from "node:assert/strict";
import { citedPages, parseCitedHref, parseCitedQuery } from "./cited-passage-query";

// docs/CITATIONS.md, "The link" — what a citation's link at a page carries
// for the cited-page route, the integrity check and MCP's write check.

test("a text alone is a quotation, read before decoding as a fragment's is", () => {
  assert.deepEqual(parseCitedQuery("text=could+not+yet...his+own"), {
    kind: "quotation",
    text: { prefix: null, segments: [{ start: "could not yet", end: null }, { start: "his own", end: null }], suffix: null },
  });
  // An attached bracket arrives encoded and is decoded into its word, still to settle.
  const bracketed = parseCitedQuery("text=%5BT%5Dhe+soul");
  assert.equal(bracketed.kind === "quotation" && bracketed.text.segments[0].start, "[T]he soul");
  // The server hands a route its commas encoded, so one is syntax encoded or not, unlike in a fragment.
  const comma = parseCitedQuery("text=one%2C+two");
  assert.equal(comma.kind === "quotation" && comma.text.segments[0].end, "two");
  assert.deepEqual(parseCitedQuery("p=8&text=a%2Cb"), { kind: "pairs", fragment: "p=8&text=a,b" });
  assert.deepEqual(parseCitedQuery("text=..."), { kind: "unreadable" });
  assert.deepEqual(parseCitedQuery(""), { kind: "none" });
  assert.deepEqual(parseCitedQuery("utm_source=x"), { kind: "none" });
});

test("with a page, the page and text pairs are the fragment, in order and as written", () => {
  assert.deepEqual(parseCitedQuery("p=49&text=a+b...c&page=54&text=d&zoom=200"), { kind: "pairs", fragment: "p=49&text=a+b...c&page=54&text=d" });
  assert.deepEqual(parseCitedQuery("?page=3"), { kind: "pairs", fragment: "page=3" });
});

test("the cited pages: one, or the first and last a locator of several names", () => {
  assert.deepEqual(citedPages("49"), { first: "49", last: "49" });
  assert.deepEqual(citedPages("49–50"), { first: "49", last: "50" });
  assert.deepEqual(citedPages("pp. 49-51"), { first: "49", last: "51" });
  assert.deepEqual(citedPages("49, 51"), { first: "49", last: "51" });
  assert.deepEqual(citedPages("xii"), { first: "xii", last: "xii" });
  assert.equal(citedPages("ch. 3"), null);
});

test("a citation's link with a query, relative or on this origin; anything else is none", () => {
  assert.deepEqual(parseCitedHref("/references/barfield1957/p/49?text=his+own", null), { segment: "barfield1957", page: "49", query: "text=his+own" });
  assert.deepEqual(parseCitedHref(`/references/a%3Ab/p/${encodeURIComponent("49–50")}?text=x`, null), { segment: "a:b", page: "49–50", query: "text=x" });
  assert.deepEqual(parseCitedHref("https://site.example/references/bu/p/2?p=2&text=x", "https://site.example"), { segment: "bu", page: "2", query: "p=2&text=x" });
  for (const href of ["/references/bu/p/49", "/references/bu?text=x", "/references/bu/p/49/x?text=y", "https://elsewhere.example/references/bu/p/2?text=x", "/pdf/x#page=2&text=a"]) {
    assert.equal(parseCitedHref(href, "https://site.example"), null, href);
  }
});
