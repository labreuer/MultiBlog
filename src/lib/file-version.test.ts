import assert from "node:assert/strict";
import { test } from "node:test";
import {
  elapsedInLargestUnit,
  filesPath,
  fileVersionState,
  fileVersionTitle,
  latestVersionOf,
  linkPartsVersions,
  pageStampFor,
  parseCaptureOrigin,
  parsePdfPath,
  parseVersionNumber,
  pdfPath,
} from "./file-version";

const SECOND = 1_000;
const DAY = 86_400 * SECOND;

test("a version's number is digits from 1 and nothing else", () => {
  assert.equal(parseVersionNumber("1"), 1);
  assert.equal(parseVersionNumber("27"), 27);
  for (const raw of ["0", "01", "-1", "+1", "1x", "x1", "1.0", " 1", "", "v1", "1e3", "12345678901"]) {
    assert.equal(parseVersionNumber(raw), null, raw);
  }
  assert.equal(parseVersionNumber(null), null);
  assert.equal(parseVersionNumber(undefined), null);
});

test("a state is read from the row and the file's pointer", () => {
  const at = new Date(0);
  const promoted = { id: "a", promotedAt: at, abandonedAt: null };
  assert.equal(fileVersionState(promoted, "a"), "latest");
  assert.equal(fileVersionState(promoted, "b"), "earlier");
  assert.equal(fileVersionState({ id: "c", promotedAt: null, abandonedAt: null }, "a"), "candidate");
  assert.equal(fileVersionState({ id: "d", promotedAt: null, abandonedAt: at }, "a"), "abandoned");
});

test("a file without a latest version throws, and one with it hands it back", () => {
  assert.deepEqual(latestVersionOf({ id: "f", currentVersion: { sha256: "x" } }), { sha256: "x" });
  assert.throws(() => latestVersionOf({ id: "f", currentVersion: null }), /File f has no latest version/);
});

test("the latest is read at the bare address and any other version at its own", () => {
  const latest = { number: 2, isLatest: true };
  const earlier = { number: 1, isLatest: false };
  assert.equal(pdfPath("book"), "/pdf/book");
  assert.equal(pdfPath("book", null), "/pdf/book");
  assert.equal(pdfPath("book", latest), "/pdf/book");
  assert.equal(pdfPath("book", earlier), "/pdf/book/v/1");
  // A version's own address names it whatever its state.
  assert.equal(pdfPath("book", latest, { own: true }), "/pdf/book/v/2");
  assert.equal(filesPath("book", latest), "/files/book");
  assert.equal(filesPath("book", earlier), "/files/book/v/1");
  assert.equal(filesPath("book", latest, { own: true }), "/files/book/v/2");
});

test("a version that is not the latest is named with its number", () => {
  assert.equal(fileVersionTitle("Book", { number: 2, isLatest: true }), "Book");
  assert.equal(fileVersionTitle("Book", { number: 1, isLatest: false }), "Book, version 1");
  assert.equal(fileVersionTitle("Book", { number: 2, isLatest: true }, { always: true }), "Book, version 2");
});

test("the time between two uploads is in the largest unit that fits, rounded to the nearest", () => {
  assert.equal(elapsedInLargestUnit(0), "0 seconds");
  assert.equal(elapsedInLargestUnit(1_400), "1 second");
  assert.equal(elapsedInLargestUnit(40 * SECOND), "40 seconds");
  assert.equal(elapsedInLargestUnit(90 * SECOND), "2 minutes");
  assert.equal(elapsedInLargestUnit(40 * 3_600 * SECOND), "2 days");
  assert.equal(elapsedInLargestUnit(DAY), "1 day");
  assert.equal(elapsedInLargestUnit(45 * DAY), "1 month");
  assert.equal(elapsedInLargestUnit(100 * DAY), "3 months");
  assert.equal(elapsedInLargestUnit(800 * DAY), "2 years");
  // Either order: the banner states a distance.
  assert.equal(elapsedInLargestUnit(-100 * DAY), "3 months");
});

test("a link lands on the newest version holding one of its parts, and its file is named with its parts' versions wherever one is not the latest", () => {
  const v1 = { id: "one", number: 1 };
  const v2 = { id: "two", number: 2 };
  const v3 = { id: "three", number: 3 };
  // Every part on the latest: the bare address and the bare title.
  assert.deepEqual(linkPartsVersions("Book", [v2, v2], "two"), { landing: { number: 2, isLatest: true }, title: "Book" });
  // Parts on an earlier version alone open that version.
  assert.deepEqual(linkPartsVersions("Book", [v1], "two"), { landing: { number: 1, isLatest: false }, title: "Book, version 1" });
  // Parts on both: the latest, with the title saying where the rest are.
  assert.deepEqual(linkPartsVersions("Book", [v1, v2], "two"), { landing: { number: 2, isLatest: true }, title: "Book, versions 1 and 2" });
  // None on the latest: the newest of those it has.
  assert.deepEqual(linkPartsVersions("Book", [v1, v2, null], "three"), { landing: { number: 2, isLatest: false }, title: "Book, versions 1 and 2" });
  assert.deepEqual(linkPartsVersions("Book", [v1, v2, v3], "three"), { landing: { number: 3, isLatest: true }, title: "Book, versions 1, 2 and 3" });
  // A part with no version (a doc's, or a target that names none) decides nothing.
  assert.deepEqual(linkPartsVersions("Book", [null, undefined], "two"), { landing: null, title: "Book" });
});

test("a capture's origin is parsed from whatever a client sent, never cast", () => {
  assert.deepEqual(parseCaptureOrigin({ fileVersionId: "cversion", address: "bare" }), { fileVersionId: "cversion", address: "bare" });
  // Only the two fields come back: nothing else a caller sent rides along into a query.
  assert.deepEqual(parseCaptureOrigin({ fileVersionId: "cversion", address: "version", fileId: "other" }), { fileVersionId: "cversion", address: "version" });
  const refused: unknown[] = [
    null,
    undefined,
    "cversion",
    [],
    {},
    { fileVersionId: "cversion" },
    { address: "bare" },
    { fileVersionId: "", address: "bare" },
    { fileVersionId: "x".repeat(65), address: "bare" },
    { fileVersionId: "cversion", address: "latest" },
    // An object where an id belongs is a Prisma filter, not an id.
    { fileVersionId: { not: "" }, address: "bare" },
    { fileVersionId: 7, address: "bare" },
  ];
  for (const raw of refused) assert.equal(parseCaptureOrigin(raw), null, JSON.stringify(raw));
});

test("a link's stamp is its version's number once the file has a second version, and none before", () => {
  assert.equal(pageStampFor(1, 1), "sole");
  assert.equal(pageStampFor(1, 2), 1);
  assert.equal(pageStampFor(3, 3), 3);
  // A second row is a second version whatever its state, so the caller counts rows.
  assert.equal(pageStampFor(1, 4), 1);
});

test("a PDF's path is its file's address or a version's own", () => {
  assert.deepEqual(parsePdfPath("/pdf/book"), { slug: "book", version: null });
  assert.deepEqual(parsePdfPath("/pdf/book/"), { slug: "book", version: null });
  assert.deepEqual(parsePdfPath("/pdf/book/v/2"), { slug: "book", version: 2 });
  assert.deepEqual(parsePdfPath("/pdf/book/v/2/"), { slug: "book", version: 2 });
  // The form a person types, which the site redirects.
  assert.deepEqual(parsePdfPath("/pdf/book/v2"), { slug: "book", version: 2 });
  assert.deepEqual(parsePdfPath("/pdf/a%20b/v/12"), { slug: "a b", version: 12 });
  for (const path of ["/pdf", "/pdf/", "/pdf/book/v/0", "/pdf/book/v/01", "/pdf/book/v/x", "/pdf/book/v/", "/pdf/book/map", "/pdf/book/v/2/map", "/doc/book", "/pdf/%E0%A4%A"]) {
    assert.equal(parsePdfPath(path), null, path);
  }
});
