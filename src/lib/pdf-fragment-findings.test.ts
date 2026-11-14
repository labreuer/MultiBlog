import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkPage,
  checkPassage,
  checkPassageAt,
  parseFragmentLinkHref,
  passageElsewhere,
  readPageLink,
  readPassage,
  versionNamedBy,
  type FilePages,
  type PassageSource,
} from "./pdf-fragment-findings";
import { onePassage, resolvePassage, skeletonOf, type FragmentPassage } from "./pdf-fragment";
import { readPage, type LinkAddress, type LinkVersion } from "./pdf-link-reading";
import type { PageName } from "./pdf-open-params";
import { REMOVED } from "./pdf-page-map";

// docs/PDF_FRAGMENT_LINKS.md §8 — which hrefs the check reads, and what a
// passage or a page link comes to against a file's pages, with labels and
// without. The pages are plain sentences: the skeleton match has its own
// tests in pdf-fragment.test.ts.

const ORIGIN = "https://blog.example";

test("an href with text is a fragment link, and one with a page or a p and no text a page link", () => {
  assert.deepEqual(parseFragmentLinkHref("/pdf/book#p=49&text=a,b", null), {
    slug: "book",
    version: null,
    passages: [{ page: { label: "49" }, prefix: null, segments: [{ start: "a", end: "b" }], suffix: null }],
    page: null,
    unread: 0,
  });
  assert.deepEqual(parseFragmentLinkHref("/pdf/book#page=5", null), { slug: "book", version: null, passages: [], page: { sheet: 5 }, unread: 0 });
  assert.deepEqual(parseFragmentLinkHref("/pdf/book#sheet=5", null), { slug: "book", version: null, passages: [], page: { sheet: 5 }, unread: 0 });
  assert.deepEqual(parseFragmentLinkHref("/pdf/book#p=xii", null), { slug: "book", version: null, passages: [], page: { label: "xii" }, unread: 0 });
  assert.deepEqual(parseFragmentLinkHref(`${ORIGIN}/pdf/book#zoom=2&p=3`, ORIGIN)?.page, { label: "3" });
  // Neither: no page that reads, an annotation's permalink, no fragment at all, another site.
  for (const href of ["/pdf/book", "/pdf/book#page=x", "/pdf/book#p=", "/pdf/book#ada-lovelace-2026-10-04-12-00-00", "https://elsewhere.example/pdf/book#page=2", "/doc/x#page=2"]) {
    assert.equal(parseFragmentLinkHref(href, ORIGIN), null, href);
  }
  // A text that names no page is unread, and a link with text is never a page link.
  assert.deepEqual(parseFragmentLinkHref("/pdf/book#text=orphan&p=2", null), { slug: "book", version: null, passages: [], page: null, unread: 1 });
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
    versionNumber: 1,
    stamp: "sole",
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
  assert.deepEqual(checkPage({ versionNumber: 1, pageCount: 5 }, ["i", "1", "1", "2", ""], { label: "1" }), { kind: "ok", version: 1, sheet: 2 });
  assert.deepEqual(checkPage({ versionNumber: 1, pageCount: 5 }, ["i", "1", "1", "2", ""], { label: "49" }), { kind: "no-such-label", version: 1 });
  assert.deepEqual(checkPage({ versionNumber: 1, pageCount: 5 }, ["i", "1", "1", "2", ""], { label: "5" }), { kind: "no-such-label", version: 1 });
  assert.deepEqual(checkPage({ versionNumber: 1, pageCount: 5 }, [], { label: "5" }), { kind: "ok", version: 1, sheet: 5 });
  assert.deepEqual(checkPage({ versionNumber: 1, pageCount: 5 }, [], { label: "6" }), { kind: "page-out-of-range", version: 1, pageCount: 5 });
  assert.deepEqual(checkPage({ versionNumber: 1, pageCount: 5 }, null, { sheet: 6 }), { kind: "page-out-of-range", version: 1, pageCount: 5 });
  assert.deepEqual(checkPage({ versionNumber: 1, pageCount: 5 }, null, { sheet: 5 }), { kind: "ok", version: 1, sheet: 5 });
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

test("a link to a version's own address is a link into that version", () => {
  const onVersion = parseFragmentLinkHref("/pdf/book/v/2#sheet=5&text=law+of+participation", null);
  assert.equal(onVersion?.slug, "book");
  assert.equal(onVersion?.version, 2);
  assert.deepEqual(onVersion?.passages.map((p) => p.page), [{ sheet: 5 }]);
  // The form a person types, and a page link.
  assert.deepEqual(parseFragmentLinkHref("/pdf/book/v3#p=49", null), { slug: "book", version: 3, passages: [], page: { label: "49" }, unread: 0 });
  assert.equal(parseFragmentLinkHref("https://site.example/pdf/book/v/2#sheet=5&text=a", "https://site.example")?.version, 2);
  // No other path under the file is a link into it.
  assert.equal(parseFragmentLinkHref("/pdf/book/v/x#sheet=5&text=a", null), null);
  assert.equal(parseFragmentLinkHref("/pdf/book/v/2/map#sheet=5", null), null);
});

test("each page of a link names a version: its stamp, the address's, or the first", () => {
  const bare = parseFragmentLinkHref("/pdf/book#sheet=5&text=a&sheet=6&v=3&text=b", null)!;
  assert.deepEqual(bare.passages.map((p) => versionNamedBy(bare, p.page)), [1, 3]);
  const onVersion = parseFragmentLinkHref("/pdf/book/v/2#sheet=5&text=a&sheet=6&v=3&text=b", null)!;
  assert.deepEqual(onVersion.passages.map((p) => versionNamedBy(onVersion, p.page)), [2, 3]);
  const pageLink = parseFragmentLinkHref("/pdf/book#p=49&v=2", null)!;
  assert.deepEqual(pageLink.page, { label: "49", v: 2 });
  assert.equal(versionNamedBy(pageLink, pageLink.page!), 2);
});

test("a finding names the version it was read on", () => {
  const second: FilePages = { ...LABELLED, versionNumber: 2, stamp: 2 };
  const ok = checkPassage(second, passage({ label: "1" }, "law of participation"));
  assert.equal(ok.kind === "ok" && ok.version, 2);
  const miss = checkPassage(second, passage({ sheet: 1 }, "the totem passage"));
  assert.equal(miss.kind === "no-match" && miss.version, 2);
  assert.deepEqual(checkPage(second, second.ownLabels, { sheet: 9 }), { kind: "page-out-of-range", version: 2, pageCount: 5 });
});

// docs/PDF.md §13, "Links into the file" — the check reads a link as the
// viewer does: carried through the page maps, and checked where it lands.
//
// Three versions of one text. Version 2 is a better copy of version 1: its
// first sheet is gone, so every sheet moved up one, and "modem" on the third
// sheet was corrected to "modern". Version 3 is a revised text with no map,
// which cut the totem passage.
function versionPages(versionNumber: number, texts: readonly string[]): FilePages {
  return {
    fileId: "f",
    slug: "book",
    versionNumber,
    stamp: versionNumber,
    pageCount: texts.length,
    textVersion: "v",
    ownLabels: [],
    pages: new Map(texts.map((text, index) => [index, { text, skeleton: skeletonOf(text) }])),
  };
}

const FIRST = versionPages(1, ["A cover sheet.", "The law of participation holds here.", "The modem mind stands apart.", "A totem passage closes the chapter."]);
const BETTER = versionPages(2, ["The law of participation holds here.", "The modern mind stands apart.", "A totem passage closes the chapter."]);
const REVISED = versionPages(3, ["The law of participation holds here, somewhat revised.", "The modern mind stands apart."]);
const PAGES = new Map([FIRST, BETTER, REVISED].map((pages) => [pages.versionNumber, pages]));

const versionsWith = (latest: number): LinkVersion[] => [
  { number: 1, state: "earlier", base: null, map: null, pageCount: 4 },
  { number: 2, state: latest === 2 ? "latest" : "earlier", base: 1, map: [REMOVED, 0, 1, 2], pageCount: 3 },
  ...(latest === 3 ? [{ number: 3, state: "latest" as const, base: 2, map: null, pageCount: 2 }] : []),
];

/** The check's source over the made pages: what `FragmentChecker` is over stored page text. */
const SOURCE: PassageSource = {
  onVersion: async (version, linked) => checkPassage(PAGES.get(version)!, linked),
  onSheets: async (version, linked, sheets) => checkPassageAt(PAGES.get(version)!, linked, sheets),
  held: async (version, linked, sheets) =>
    sheets.some((index) => {
      const sheet = PAGES.get(version)!.pages.get(index);
      return sheet !== undefined && resolvePassage(sheet.text, linked, sheet.skeleton) !== null;
    }),
  pageOnVersion: async (version, page) => checkPage(PAGES.get(version)!, [], page),
};

const read = (linked: FragmentPassage, address: LinkAddress, versions: LinkVersion[]) =>
  readPassage(linked, readPage(linked.page, address, versions), address.shown, SOURCE);

test("a link carried to a sheet that holds its words is checked there, and is no fault", async () => {
  // Written against version 1, without a stamp: its sheet 2 is the latest's sheet 1.
  const finding = await read(passage({ sheet: 2 }, "law of participation"), { shown: 2, own: false }, versionsWith(2));
  assert.deepEqual(finding && [finding.kind, finding.version, finding.kind === "ok" && finding.sheet, finding.kind === "ok" && finding.carried], ["ok", 2, 1, { from: 1 }]);
  // A link that names the latest is read there as written, and carries nothing.
  const here = await read(passage({ sheet: 1, v: 2 }, "law of participation"), { shown: 2, own: false }, versionsWith(2));
  assert.deepEqual(here && [here.kind, here.version, here.kind === "ok" && here.carried], ["ok", 2, undefined]);
});

test("a link carried to a sheet where its words were corrected is a miss where it lands", async () => {
  const finding = await read(passage({ sheet: 3 }, "modem mind"), { shown: 2, own: false }, versionsWith(2));
  assert.equal(finding?.kind, "no-match");
  assert.deepEqual(finding?.kind === "no-match" && [finding.version, finding.sheets, finding.carried], [2, [2], { from: 1, namedHolds: true }]);
  // Words neither version holds: the version named doesn't hold them either.
  const never = await read(passage({ sheet: 3 }, "postmodern mind"), { shown: 2, own: false }, versionsWith(2));
  assert.deepEqual(never?.kind === "no-match" && never.carried, { from: 1, namedHolds: false });
});

test("a link that can't be carried is checked on the version it names, whatever the latest lacks", async () => {
  // A revised text stands between: no map joins version 1 to version 3, so the link opens version 1.
  const finding = await read(passage({ sheet: 4 }, "totem passage"), { shown: 3, own: false }, versionsWith(3));
  assert.deepEqual(finding && [finding.kind, finding.version, finding.kind === "ok" && finding.carried], ["ok", 1, undefined]);
  // And one stamped with version 2, whose words version 3 cut, is checked on version 2.
  const second = await read(passage({ sheet: 3, v: 2 }, "totem passage"), { shown: 3, own: false }, versionsWith(3));
  assert.deepEqual(second && [second.kind, second.version], ["ok", 2]);
});

test("a link onto a sheet with no counterpart is carried by its words, or not at all", async () => {
  // Version 1's cover sheet was removed. Its words are nowhere in version 2, so the link opens version 1, where they are.
  const cover = await read(passage({ sheet: 1 }, "cover sheet"), { shown: 2, own: false }, versionsWith(2));
  assert.deepEqual(cover && [cover.kind, cover.version], ["ok", 1]);
  // A link that names that sheet for words another sheet holds, once: carried by its words.
  const stray = await read(passage({ sheet: 1 }, "totem passage"), { shown: 2, own: false }, versionsWith(2));
  assert.deepEqual(stray && [stray.kind, stray.version, stray.kind === "ok" && stray.sheet, stray.kind === "ok" && stray.carried], ["ok", 2, 3, { from: 1, byWords: true }]);
});

test("a link that names a version with nothing to read is its fault", async () => {
  const versions: LinkVersion[] = [...versionsWith(2), { number: 3, state: "abandoned", base: 2, map: null, pageCount: 3 }, { number: 4, state: "abandoned", base: 2, map: [0, REMOVED, 1], pageCount: 3 }];
  const bare = { shown: 2, own: false };
  // Abandoned with no map: nothing can confirm it.
  assert.deepEqual(await read(passage({ sheet: 1, v: 3 }, "law of participation"), bare, versions), {
    kind: "abandoned-version",
    version: 3,
    passage: passage({ sheet: 1, v: 3 }, "law of participation"),
  });
  // Abandoned with a map: carried off it, and checked where it lands.
  const carried = await read(passage({ sheet: 1, v: 4 }, "law of participation"), bare, versions);
  assert.deepEqual(carried && [carried.kind, carried.version, carried.kind === "ok" && carried.carried], ["ok", 2, { from: 4 }]);
  // Its sheet with no counterpart, and words that are nowhere: the fault says the maps were there.
  const lost = await read(passage({ sheet: 3, v: 4 }, "nowhere at all"), bare, versions);
  assert.deepEqual(lost && [lost.kind, lost.kind === "abandoned-version" && lost.mapped], ["abandoned-version", true]);
  // A version the file never had.
  const none = await read(passage({ sheet: 1, v: 9 }, "law of participation"), bare, versions);
  assert.equal(none?.kind, "no-such-version");
});

test("a page link is carried to the sheet the maps give, or opens the version it names", async () => {
  const versions = versionsWith(2);
  const bare = { shown: 2, own: false };
  const link = (page: PageName) => readPageLink(page, readPage(page, bare, versions), 2, SOURCE);
  assert.deepEqual(await link({ sheet: 3 }), { kind: "ok", version: 2, sheet: 2, carried: { from: 1 } });
  // The removed sheet: not carried, so it is read on version 1.
  assert.deepEqual(await link({ sheet: 1 }), { kind: "ok", version: 1, sheet: 1 });
  assert.deepEqual(await link({ sheet: 9 }), { kind: "page-out-of-range", version: 1, pageCount: 4 });
  assert.deepEqual(await link({ sheet: 2, v: 2 }), { kind: "ok", version: 2, sheet: 2 });
});
