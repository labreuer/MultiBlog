import { test } from "node:test";
import assert from "node:assert/strict";
import { pageFromHash } from "./pdf-open-params";
import { parseFragmentPassages } from "./pdf-fragment";
import {
  namedVersion,
  opensSheetAsWritten,
  readByWordsAlone,
  readPage,
  stampedFragment,
  versionToOpen,
  type LinkAddress,
  type LinkVersion,
} from "./pdf-link-reading";

// docs/PDF.md §13, "Links into the file" — a link's reading against a file's
// versions. No version has a page map yet, so no link is carried: a link that
// names another version than the one shown opens the version it names.

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
