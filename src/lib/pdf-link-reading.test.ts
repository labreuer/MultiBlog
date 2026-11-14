import { test } from "node:test";
import assert from "node:assert/strict";
import { pageFromHash } from "./pdf-open-params";
import { parseFragmentPassages } from "./pdf-fragment";
import {
  arrivalOf,
  carriedElsewhere,
  linkVersionsJson,
  namedVersion,
  openingOf,
  parseLinkVersions,
  readByWordsAlone,
  readPage,
  referentTarget,
  stampedFragment,
  type LinkAddress,
  type LinkVersion,
} from "./pdf-link-reading";
import { REMOVED, UNMAPPED } from "./pdf-page-map";

// docs/PDF.md §13, "Links into the file" — a link's reading against a file's
// versions. The first half is a file whose versions have no page map between
// them, where a link that names another version than the one shown opens the
// version it names. The second half is a file with maps, where a link is
// carried.

/** The number of the version a link read on the bare address goes to; null to stay. */
function versionToOpen(fragment: string, address: LinkAddress, versions: readonly LinkVersion[]): number | null {
  const arrival = arrivalOf(fragment, address, versions);
  return arrival.kind === "open" ? arrival.version : null;
}

/** Whether the viewer opens at the sheet a page names, as written. */
const opensSheetAsWritten = (reading: ReturnType<typeof readPage>) => openingOf(reading) === "as-written";

// A file with three promoted versions, an abandoned fourth and a candidate fifth.
const VERSIONS: LinkVersion[] = [
  { number: 1, state: "earlier" },
  { number: 2, state: "earlier" },
  { number: 3, state: "latest" },
  { number: 4, state: "abandoned" },
  { number: 5, state: "candidate" },
];
const BARE: LinkAddress = { shown: 3, own: false };
const own = (shown: number): LinkAddress => ({ shown, own: true });
const page = (hash: string) => pageFromHash(hash)!;

test("a link without v= names the file's first version, by sheet and by page", () => {
  assert.equal(namedVersion(page("#sheet=50"), BARE), 1);
  assert.equal(namedVersion(page("#p=49"), BARE), 1);
  assert.equal(namedVersion(page("#page=50"), BARE), 1);
  // A stamp says which, in either form.
  assert.equal(namedVersion(page("#sheet=50&v=3"), BARE), 3);
  assert.equal(namedVersion(page("#p=49&v=2"), BARE), 2);
});

test("on a version's own address a link without v= names that version", () => {
  assert.equal(namedVersion(page("#sheet=49"), own(2)), 2);
  assert.equal(namedVersion(page("#p=49"), own(3)), 3);
  // A stamp still says which: the address says which version is shown, v= whose sheets the link counts.
  assert.equal(namedVersion(page("#sheet=50&v=1"), own(2)), 1);
});

test("a link that names the version shown is read there", () => {
  assert.deepEqual(readPage(page("#sheet=50&v=3"), BARE, VERSIONS), { kind: "here", version: 3 });
  assert.deepEqual(readPage(page("#p=49&v=3"), BARE, VERSIONS), { kind: "here", version: 3 });
  assert.deepEqual(readPage(page("#sheet=50"), own(2), VERSIONS), { kind: "here", version: 2 });
  assert.deepEqual(readPage(page("#sheet=50&v=1"), own(1), VERSIONS), { kind: "here", version: 1 });
  // A file with one version: every unstamped link names it, and it is the one shown.
  assert.deepEqual(readPage(page("#sheet=50"), { shown: 1, own: false }, [{ number: 1, state: "latest" }]), { kind: "here", version: 1 });
  assert.equal(opensSheetAsWritten({ kind: "here", version: 3 }), true);
});

test("with no page map on the way, a link opens the version it names", () => {
  // From the bare address, unstamped: the first version.
  assert.deepEqual(readPage(page("#sheet=50"), BARE, VERSIONS), { kind: "elsewhere", version: 1, state: "earlier" });
  assert.equal(versionToOpen("#sheet=50", BARE, VERSIONS), 1);
  assert.equal(versionToOpen("#p=49&text=law+of+participation", BARE, VERSIONS), 1);
  // Stamped with an earlier version, or with a candidate.
  assert.equal(versionToOpen("#sheet=50&v=2&text=a", BARE, VERSIONS), 2);
  assert.equal(versionToOpen("#p=49&v=5", BARE, VERSIONS), 5);
  // Stamped with the latest, it stays.
  assert.equal(versionToOpen("#sheet=50&v=3&text=a", BARE, VERSIONS), null);
  // A fragment that names no page is no link: a card's name stays where it is.
  assert.equal(versionToOpen("#ada-lovelace-2026-10-04-12-00-00", BARE, VERSIONS), null);
  assert.equal(versionToOpen("", BARE, VERSIONS), null);
  // Such a page names a sheet of other bytes, so the viewer opens at none here.
  assert.equal(opensSheetAsWritten(readPage(page("#sheet=50"), BARE, VERSIONS)), false);
});

test("on a version's own address the viewer stays, whatever the link names", () => {
  assert.equal(versionToOpen("#sheet=50&v=1", own(2), VERSIONS), null);
  assert.equal(versionToOpen("#sheet=50&v=3", own(1), VERSIONS), null);
  // The reading still says the link is another version's, for the banner to offer it there.
  assert.deepEqual(readPage(page("#sheet=50&v=1"), own(2), VERSIONS), { kind: "elsewhere", version: 1, state: "earlier" });
  assert.deepEqual(readPage(page("#sheet=50&v=3"), own(1), VERSIONS), { kind: "elsewhere", version: 3, state: "latest" });
});

test("a link whose passages name different versions goes by its first", () => {
  assert.equal(versionToOpen("#sheet=5&text=a&sheet=6&v=3&text=b", BARE, VERSIONS), 1);
  assert.equal(versionToOpen("#sheet=5&v=3&text=a&sheet=6&v=1&text=b", BARE, VERSIONS), null);
  // Each passage is still read by its own stamp.
  const readings = parseFragmentPassages("#sheet=5&v=3&text=a&sheet=6&v=1&text=b").map((passage) => readPage(passage.page, BARE, VERSIONS).kind);
  assert.deepEqual(readings, ["here", "elsewhere"]);
});

test("a link stamped with an abandoned version that kept no map has no version to open", () => {
  const reading = readPage(page("#sheet=50&v=4&text=a"), BARE, VERSIONS);
  assert.deepEqual(reading, { kind: "abandoned", version: 4 });
  // The viewer stays, looks for the words alone, and sends a link without words nowhere.
  assert.equal(versionToOpen("#sheet=50&v=4&text=a", BARE, VERSIONS), null);
  assert.equal(versionToOpen("#sheet=50&v=4", own(1), VERSIONS), null);
  assert.equal(readByWordsAlone(reading), true);
  assert.equal(opensSheetAsWritten(reading), false);
});

test("a link stamped with a version the file lacks opens the sheet as written", () => {
  const reading = readPage(page("#sheet=50&v=9"), BARE, VERSIONS);
  assert.deepEqual(reading, { kind: "no-such-version", version: 9 });
  assert.equal(versionToOpen("#sheet=50&v=9", BARE, VERSIONS), null);
  assert.equal(opensSheetAsWritten(reading), true);
  assert.equal(readByWordsAlone(reading), true);
  // What v=2 gets on another file that has taken a deleted file's slug.
  assert.deepEqual(readPage(page("#p=49&v=2"), { shown: 1, own: false }, [{ number: 1, state: "latest" }]), { kind: "no-such-version", version: 2 });
  // Neither a link of the version shown nor one of another readable version is looked for by its words alone.
  assert.equal(readByWordsAlone({ kind: "here", version: 3 }), false);
  assert.equal(readByWordsAlone({ kind: "elsewhere", version: 1, state: "earlier" }), false);
});

test("a link is written on with each page stamped by the version it names", () => {
  // Once the file has a second version, an unstamped page says the first, and page= leaves as sheet=.
  assert.equal(stampedFragment("page=50&text=law+of+participation", BARE, 5), "sheet=50&v=1&text=law+of+participation");
  assert.equal(stampedFragment("#p=49", BARE, 5), "p=49&v=1");
  assert.equal(stampedFragment("sheet=5&v=3&text=a&p=xii&text=b", BARE, 5), "sheet=5&v=3&text=a&p=xii&v=1&text=b");
  // On a version's own address an unstamped page names that version.
  assert.equal(stampedFragment("sheet=49&text=a", own(2), 5), "sheet=49&v=2&text=a");
  // A file with one version writes no stamp, but keeps one a link brought, so the viewer can say the file has no such version.
  assert.equal(stampedFragment("page=50&text=a", { shown: 1, own: false }, 1), "sheet=50&text=a");
  assert.equal(stampedFragment("sheet=50&v=2", { shown: 1, own: false }, 1), "sheet=50&v=2");
  // Nothing that names a page is nothing to write.
  assert.equal(stampedFragment("text=orphan", BARE, 5), null);
  assert.equal(stampedFragment("", BARE, 5), null);
});

test("a referent's pairs go to the version they name, written anew", async () => {
  // Unstamped, on a file with several versions: version 1's own address, the page= leaving as sheet=.
  assert.equal(await referentTarget("book", "page=53&text=law+of+participation", 3, VERSIONS), "/pdf/book/v/1#sheet=53&v=1&text=law+of+participation");
  // Stamped with the latest: the bare address.
  assert.equal(await referentTarget("book", "p=49&v=3&text=law+of+participation", 3, VERSIONS), "/pdf/book#p=49&v=3&text=law+of+participation");
  assert.equal(await referentTarget("book", "sheet=53&v=2", 3, VERSIONS), "/pdf/book/v/2#sheet=53&v=2");
  // An abandoned version, or one the file never had, has no address to go to: the bare one, where the viewer says so.
  assert.equal(await referentTarget("book", "sheet=53&v=4&text=a", 3, VERSIONS), "/pdf/book#sheet=53&v=4&text=a");
  assert.equal(await referentTarget("book", "sheet=53&v=9", 3, VERSIONS), "/pdf/book#sheet=53&v=9");
  // A file with one version: nothing to stamp, and nowhere else to go.
  assert.equal(await referentTarget("book", "page=53&text=a", 1, [{ number: 1, state: "latest" }]), "/pdf/book#sheet=53&text=a");
  // Pairs that name no page are no link.
  assert.equal(await referentTarget("book", "text=orphan", 3, VERSIONS), null);
});

test("a file's versions round-trip through the string a client component memoises on", () => {
  const json = linkVersionsJson(MAPPED);
  assert.deepEqual(parseLinkVersions(json), MAPPED);
  // The same versions in a new array are the same string: what keeps a server refresh from re-reading a link.
  assert.equal(linkVersionsJson(MAPPED.map((version) => ({ ...version }))), json);
  assert.deepEqual(parseLinkVersions(linkVersionsJson([])), []);
});

// A file whose versions are better copies of one text, with a page map from
// each to the next:
//
// - version 1 has six sheets, labelled i, 1, 2, 3, 4, 5;
// - version 2 lost version 1's first sheet, so every sheet moved up one, and
//   version 1's fifth sheet could not be placed in it;
// - version 3, the latest, gained a blank sheet after its first;
// - version 4 was abandoned over version 3, and kept its map;
// - version 5 was abandoned over version 3 with none;
// - version 6 is a candidate over version 3, a revised text with no map.
const MAPPED: LinkVersion[] = [
  { number: 1, state: "earlier", base: null, map: null, pageCount: 6, labels: ["i", "1", "2", "3", "4", "5"] },
  { number: 2, state: "earlier", base: 1, map: [REMOVED, 0, 1, 2, UNMAPPED, 4], pageCount: 5, labels: ["1", "2", "3", "4", "5"] },
  { number: 3, state: "latest", base: 2, map: [0, 2, 3, 4, 5], pageCount: 6, labels: ["1", "", "2", "3", "4", "5"] },
  { number: 4, state: "abandoned", base: 3, map: [0, 1, 2, 3, 4, 5], pageCount: 6, labels: ["1", "", "2", "3", "4", "5"] },
  { number: 5, state: "abandoned", base: 3, map: null, pageCount: 6, labels: null },
  { number: 6, state: "candidate", base: 3, map: null, pageCount: 9, labels: null },
];
const LATEST: LinkAddress = { shown: 3, own: false };

test("a link is carried through two maps to the version shown, by sheet and by page", () => {
  // Version 1's third sheet is version 2's second, and version 3's third.
  assert.deepEqual(readPage(page("#sheet=3"), LATEST, MAPPED), { kind: "carried", version: 1, state: "earlier", named: [2], sheets: [2] });
  assert.deepEqual(readPage(page("#sheet=2&v=1"), LATEST, MAPPED), { kind: "carried", version: 1, state: "earlier", named: [1], sheets: [0] });
  // A page is read on the labels of the version it names, and carried as a sheet is.
  assert.deepEqual(readPage(page("#p=3"), LATEST, MAPPED), { kind: "carried", version: 1, state: "earlier", named: [3], sheets: [3] });
  assert.deepEqual(readPage(page("#p=1&v=2"), LATEST, MAPPED), { kind: "carried", version: 2, state: "earlier", named: [0], sheets: [0] });
  // It stays, and the viewer opens at the sheet it reached.
  assert.deepEqual(arrivalOf("#sheet=2&v=1", LATEST, MAPPED), { kind: "stay" });
  assert.equal(openingOf(readPage(page("#sheet=2&v=1"), LATEST, MAPPED)), 1);
  assert.equal(openingOf(readPage(page("#p=3"), LATEST, MAPPED)), 4);
  // Stamped with the version shown, it is read there as written.
  assert.deepEqual(readPage(page("#sheet=3&v=3"), LATEST, MAPPED), { kind: "here", version: 3 });
});

test("a link is carried backwards, from a version's own address", () => {
  // The latest's fourth sheet is version 2's third, and version 1's fourth.
  assert.deepEqual(readPage(page("#sheet=4&v=3"), own(1), MAPPED), { kind: "carried", version: 3, state: "latest", named: [3], sheets: [3] });
  // The blank sheet version 3 gained is one the earlier versions lack.
  assert.deepEqual(readPage(page("#sheet=2&v=3"), own(2), MAPPED), { kind: "carried", version: 3, state: "latest", named: [1], sheets: [] });
  // Unstamped on a version's own address, it names that version and is read there.
  assert.deepEqual(readPage(page("#sheet=4"), own(2), MAPPED), { kind: "here", version: 2 });
  // The viewer stays on a version's own address, whatever the reading.
  assert.deepEqual(arrivalOf("#sheet=2&v=3", own(2), MAPPED), { kind: "stay" });
});

test("a link is not carried where a map on the way is missing", () => {
  // The candidate is a revised text: a link stamped with it opens it, and one read on it is offered on the version it names.
  assert.deepEqual(readPage(page("#sheet=3&v=6"), LATEST, MAPPED), { kind: "elsewhere", version: 6, state: "candidate" });
  assert.deepEqual(arrivalOf("#sheet=3&v=6&text=some+words", LATEST, MAPPED), { kind: "open", version: 6 });
  assert.deepEqual(readPage(page("#sheet=3&v=1"), own(6), MAPPED), { kind: "elsewhere", version: 1, state: "earlier" });
  assert.equal(openingOf(readPage(page("#sheet=3&v=1"), own(6), MAPPED)), null);
});

test("a sheet with no counterpart is carried only by its words", () => {
  // Version 1's first sheet was removed, and its fifth was never placed.
  const removed = readPage(page("#sheet=1"), LATEST, MAPPED);
  assert.deepEqual(removed, { kind: "carried", version: 1, state: "earlier", named: [0], sheets: [] });
  assert.deepEqual(readPage(page("#sheet=5&v=1"), LATEST, MAPPED), { kind: "carried", version: 1, state: "earlier", named: [4], sheets: [] });
  assert.equal(openingOf(removed), null);
  // With words, the server is asked whether they are on exactly one sheet here.
  const withWords = arrivalOf("#sheet=1&text=law+of+participation", LATEST, MAPPED);
  assert.equal(withWords.kind, "by-words");
  assert.deepEqual(withWords.kind === "by-words" && [withWords.version, withWords.passage.segments], [1, [{ start: "law of participation", end: null }]]);
  // Without words it is not carried, and opens the version it names.
  assert.deepEqual(arrivalOf("#sheet=1", LATEST, MAPPED), { kind: "open", version: 1 });
  // A label no sheet of the version named carries names no sheet to carry.
  assert.deepEqual(readPage(page("#p=xii"), LATEST, MAPPED), { kind: "carried", version: 1, state: "earlier", named: [], sheets: [] });
});

test("a link stamped with an abandoned version is carried off it where it kept a map", () => {
  assert.deepEqual(readPage(page("#sheet=3&v=4"), LATEST, MAPPED), { kind: "carried", version: 4, state: "abandoned", named: [2], sheets: [2] });
  assert.deepEqual(arrivalOf("#sheet=3&v=4", LATEST, MAPPED), { kind: "stay" });
  // Back to its base and on to an earlier version.
  assert.deepEqual(readPage(page("#sheet=3&v=4"), own(1), MAPPED), { kind: "carried", version: 4, state: "abandoned", named: [2], sheets: [2] });
  // One that kept none has no version to open: its words alone, and a link without words nowhere.
  const lost = readPage(page("#sheet=3&v=5"), LATEST, MAPPED);
  assert.deepEqual(lost, { kind: "abandoned", version: 5 });
  assert.equal(readByWordsAlone(lost), true);
  assert.equal(openingOf(lost), null);
  assert.deepEqual(arrivalOf("#sheet=3&v=5", LATEST, MAPPED), { kind: "stay" });
  // And a version the file lacks opens the sheet as written.
  assert.deepEqual(readPage(page("#sheet=3&v=9"), LATEST, MAPPED), { kind: "no-such-version", version: 9 });
  assert.equal(openingOf(readPage(page("#sheet=3&v=9"), LATEST, MAPPED)), "as-written");
});

test("a carried link says how it was read only where that changed what it opens", () => {
  const labels = MAPPED[2].labels!;
  // Version 1's sheet 3 is sheet 3 here: it opens as it always did.
  assert.equal(carriedElsewhere(page("#sheet=3"), 2, labels, 6), false);
  // Version 1's sheet 2 is sheet 1 here.
  assert.equal(carriedElsewhere(page("#sheet=2"), 0, labels, 6), true);
  // A printed page that the sheet it landed on still carries.
  assert.equal(carriedElsewhere(page("#p=3"), 3, labels, 6), false);
  assert.equal(carriedElsewhere(page("#p=3"), 4, labels, 6), true);
});

test("a referent's pairs are carried to the latest on the server, and written for it", async () => {
  // Found on the sheet it was carried to: written as the latest's sheet, stamped with the latest.
  const found = async (_passage: unknown, sheets: readonly number[]) => sheets[0] ?? null;
  assert.equal(await referentTarget("book", "sheet=2&v=1&text=law+of+participation", 3, MAPPED, found), "/pdf/book#sheet=1&v=3&text=law+of+participation");
  assert.equal(await referentTarget("book", "p=3&text=law+of+participation", 3, MAPPED, found), "/pdf/book#sheet=4&v=3&text=law+of+participation");
  // Without words, the sheet the maps give.
  assert.equal(await referentTarget("book", "sheet=2&v=1", 3, MAPPED), "/pdf/book#sheet=1&v=3");
  // Carried, and its words not found there: left as written, for the viewer to report and to offer on the version it names.
  assert.equal(await referentTarget("book", "sheet=2&v=1&text=law+of+participation", 3, MAPPED), "/pdf/book#sheet=2&v=1&text=law+of+participation");
  // A sheet with no counterpart: carried by its words where they are found once, and otherwise to the version it names.
  const elsewhere = async () => 4;
  assert.equal(await referentTarget("book", "sheet=1&v=1&text=law+of+participation", 3, MAPPED, elsewhere), "/pdf/book#sheet=5&v=3&text=law+of+participation");
  assert.equal(await referentTarget("book", "sheet=1&v=1&text=law+of+participation", 3, MAPPED), "/pdf/book/v/1#sheet=1&v=1&text=law+of+participation");
  assert.equal(await referentTarget("book", "sheet=1&v=1", 3, MAPPED), "/pdf/book/v/1#sheet=1&v=1");
  // A map missing on the way: the version it names.
  assert.equal(await referentTarget("book", "sheet=3&v=6&text=a", 3, MAPPED, found), "/pdf/book/v/6#sheet=3&v=6&text=a");
  // An abandoned version that kept its map is carried off it.
  assert.equal(await referentTarget("book", "sheet=3&v=4", 3, MAPPED), "/pdf/book#sheet=3&v=3");
});
