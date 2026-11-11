import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPage, checkPassage, parseFragmentLinkHref, passageElsewhere, type FilePages } from "./pdf-fragment-findings";
import { onePassage, skeletonOf, type FragmentPassage } from "./pdf-fragment";
import type { PageName } from "./pdf-open-params";

// docs/PDF_FRAGMENT_LINKS.md §8 — which hrefs the check reads, and what a
// passage or a page link comes to against a file's pages, with labels and
// without. The pages are plain sentences: the skeleton match has its own
// tests in pdf-fragment.test.ts.

const ORIGIN = "https://blog.example";

test("an href with text is a fragment link, and one with a page or a p and no text a page link", () => {
  assert.deepEqual(parseFragmentLinkHref("/pdf/book#p=49&text=a,b", null), {
    slug: "book",
    passages: [{ page: { label: "49" }, prefix: null, segments: [{ start: "a", end: "b" }], suffix: null }],
    page: null,
    unread: 0,
  });
  assert.deepEqual(parseFragmentLinkHref("/pdf/book#page=5", null), { slug: "book", passages: [], page: { sheet: 5 }, unread: 0 });
  assert.deepEqual(parseFragmentLinkHref("/pdf/book#p=xii", null), { slug: "book", passages: [], page: { label: "xii" }, unread: 0 });
  assert.deepEqual(parseFragmentLinkHref(`${ORIGIN}/pdf/book#zoom=2&p=3`, ORIGIN)?.page, { label: "3" });
  // Neither: no page that reads, an annotation's permalink, no fragment at all, another site.
  for (const href of ["/pdf/book", "/pdf/book#page=x", "/pdf/book#p=", "/pdf/book#ada-lovelace-2026-10-04-12-00-00", "https://elsewhere.example/pdf/book#page=2", "/doc/x#page=2"]) {
    assert.equal(parseFragmentLinkHref(href, ORIGIN), null, href);
  }
  // A text that names no page is unread, and a link with text is never a page link.
  assert.deepEqual(parseFragmentLinkHref("/pdf/book#text=orphan&p=2", null), { slug: "book", passages: [], page: null, unread: 1 });
});

const TEXTS = [
  "Front matter, the preface.", // sheet 1, label i
  "The body opens: law of participation.", // sheet 2, label 1
  "A second part restarts its numbering here.", // sheet 3, label 1
  "Only this page holds the totem passage.", // sheet 4, label 2
  "The end.", // sheet 5, no label of its own
];

function file(ownLabels: readonly string[] | null): FilePages {
  return {
    fileId: "f",
    slug: "book",
    pageCount: TEXTS.length,
    textVersion: "v",
    ownLabels,
    pages: new Map(TEXTS.map((text, index) => [index, { text, skeleton: skeletonOf(text) }])),
  };
}

const LABELLED = file(["i", "1", "1", "2", ""]);
const UNLABELLED = file([]);

const passage = (page: PageName, start: string, end: string | null = null): FragmentPassage => ({ page, ...onePassage(start, { end }) });

test("a passage is found on the first of its label's sheets that holds it", () => {
  const first = checkPassage(LABELLED, passage({ label: "1" }, "law of participation"));
  assert.equal(first.kind, "ok");
  assert.equal(first.kind === "ok" && first.sheet, 2);
  // On the label's second sheet: ok, as now, and on that sheet.
  const second = checkPassage(LABELLED, passage({ label: "1" }, "restarts its numbering"));
  assert.equal(second.kind === "ok" && second.sheet, 3);
  // A sheet still names exactly one sheet.
  assert.equal(checkPassage(LABELLED, passage({ sheet: 3 }, "restarts its numbering")).kind, "ok");
});

test("a miss names the sheets it looked on, and the one page holding it once", () => {
  const miss = checkPassage(LABELLED, passage({ label: "1" }, "the totem passage"));
  assert.equal(miss.kind, "no-match");
  if (miss.kind !== "no-match") return;
  assert.deepEqual(miss.sheets, [2, 3]);
  assert.equal(miss.foundOnPage, 4);
});

test("a label no sheet carries is its own finding, and still says where the passage is", () => {
  const finding = checkPassage(LABELLED, passage({ label: "49" }, "the totem passage"));
  assert.deepEqual(finding.kind === "no-such-label" && finding.foundOnPage, 4);
  // A filled-in number is not a label: sheet 5 is shown as "5", but its own label is empty.
  assert.equal(checkPassage(LABELLED, passage({ label: "5" }, "The end")).kind, "no-such-label");
  assert.equal(checkPassage(LABELLED, passage({ sheet: 5 }, "The end")).kind, "ok");
});

test("on a file without labels, p=N is sheet N, and past the end is out of range", () => {
  const ok = checkPassage(UNLABELLED, passage({ label: "4" }, "the totem passage"));
  assert.equal(ok.kind === "ok" && ok.sheet, 4);
  assert.equal(checkPassage(UNLABELLED, passage({ label: "9" }, "anything")).kind, "page-out-of-range");
  assert.equal(checkPassage(UNLABELLED, passage({ label: "xii" }, "anything")).kind, "no-such-label");
  assert.equal(checkPassage(UNLABELLED, passage({ sheet: 9 }, "anything")).kind, "page-out-of-range");
});

test("a page link comes to its first sheet, past the end, or a label no sheet carries", () => {
  assert.deepEqual(checkPage(5, ["i", "1", "1", "2", ""], { label: "1" }), { kind: "ok", sheet: 2 });
  assert.deepEqual(checkPage(5, ["i", "1", "1", "2", ""], { label: "49" }), { kind: "no-such-label" });
  assert.deepEqual(checkPage(5, ["i", "1", "1", "2", ""], { label: "5" }), { kind: "no-such-label" });
  assert.deepEqual(checkPage(5, [], { label: "5" }), { kind: "ok", sheet: 5 });
  assert.deepEqual(checkPage(5, [], { label: "6" }), { kind: "page-out-of-range", pageCount: 5 });
  assert.deepEqual(checkPage(5, null, { sheet: 6 }), { kind: "page-out-of-range", pageCount: 5 });
  assert.deepEqual(checkPage(5, null, { sheet: 5 }), { kind: "ok", sheet: 5 });
});

test("the viewer's question: the one sheet outside those named that holds the passage", () => {
  const text = { prefix: null, segments: [{ start: "the totem passage", end: null }], suffix: null };
  assert.equal(passageElsewhere(LABELLED, text, [1, 2]), 4);
  // On a sheet the link names, it isn't elsewhere.
  assert.equal(passageElsewhere(LABELLED, text, [3]), null);
  // Twice in the file is no answer.
  assert.equal(passageElsewhere(LABELLED, { ...text, segments: [{ start: "the", end: null }] }, []), null);
});

test("a segment that matches nowhere after the one before it is a miss, with where it stops", () => {
  const elided = (...segments: string[]): FragmentPassage => ({ page: { sheet: 4 }, prefix: null, segments: segments.map((start) => ({ start, end: null })), suffix: null });
  assert.equal(checkPassage(LABELLED, elided("Only this page", "the totem passage")).kind, "ok");
  // The second segment is on the page, but before the first: it stops matching after the first.
  const before = checkPassage(LABELLED, elided("the totem passage", "Only this"));
  assert.equal(before.kind, "no-match");
  if (before.kind !== "no-match") return;
  assert.equal(before.matchedUpTo, null);
  // A word the page spells differently, in a later segment: matched up to where it differs.
  const misspelt = checkPassage(LABELLED, elided("Only this page", "the totum passage"));
  assert.equal(misspelt.kind, "no-match");
  if (misspelt.kind !== "no-match") return;
  assert.equal(misspelt.matchedUpTo, "the tot");
  assert.equal(misspelt.pageHasThere, "em passage.");
});
