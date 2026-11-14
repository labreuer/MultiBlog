import { test } from "node:test";
import assert from "node:assert/strict";
import { formatPageName, pageFromHash, pageNameOf, stampFragment, versionStampOf } from "./pdf-open-params";

test("#sheet=n is the sheet, with or without other parameters", () => {
  assert.deepEqual(pageFromHash("#sheet=12"), { sheet: 12 });
  assert.deepEqual(pageFromHash("sheet=3"), { sheet: 3 });
  assert.deepEqual(pageFromHash("#zoom=200&sheet=7"), { sheet: 7 });
  assert.deepEqual(pageFromHash("#sheet=4&zoom=page-fit"), { sheet: 4 });
});

test("#page=n is read as sheet= for good, so a link written before sheet= keeps working", () => {
  assert.deepEqual(pageFromHash("#page=12"), { sheet: 12 });
  assert.deepEqual(pageFromHash("page=3"), { sheet: 3 });
  assert.deepEqual(pageFromHash("#zoom=200&page=7"), { sheet: 7 });
  assert.deepEqual(pageFromHash("#page=4&zoom=page-fit"), { sheet: 4 });
});

test("#p=<label> is a printed page, decoded and trimmed", () => {
  assert.deepEqual(pageFromHash("#p=49"), { label: "49" });
  assert.deepEqual(pageFromHash("#p=xii&text=a"), { label: "xii" });
  assert.deepEqual(pageFromHash("#p=A%201"), { label: "A 1" });
  assert.deepEqual(pageFromHash("#p=A+1"), { label: "A 1" });
  assert.deepEqual(pageFromHash("#p=%20iv%20"), { label: "iv" });
  // The first readable page of either form wins.
  assert.deepEqual(pageFromHash("#p=49&text=a&page=3&text=b"), { label: "49" });
  assert.deepEqual(pageFromHash("#page=x&p=7"), { label: "7" });
  assert.deepEqual(pageFromHash("#sheet=x&page=7"), { sheet: 7 });
  assert.deepEqual(pageFromHash("#sheet=2&page=7"), { sheet: 2 });
});

test("anything else asks for no page", () => {
  for (const hash of [
    "",
    "#",
    "#page=",
    "#page=0",
    "#page=-1",
    "#page=2x",
    "#page=1.5",
    "#sheet=",
    "#sheet=0",
    "#sheet=2x",
    "#sheets=3",
    "#ada-lovelace-2026-10-04-12-00-00",
    "#pages=3",
    "#p=",
    "#p=%20",
    "#p=%E2%80",
    "#ps=3",
  ]) {
    assert.equal(pageFromHash(hash), null, hash);
  }
});

test("a label is percent-encoded wherever it holds more than letters, digits, . and -", () => {
  assert.equal(formatPageName({ sheet: 5, stamp: "sole" }), "sheet=5");
  assert.deepEqual(pageFromHash(`#${formatPageName({ sheet: 5, stamp: "sole" })}`), { sheet: 5 });
  for (const plain of ["49", "xii", "A-1", "B.3"]) assert.equal(formatPageName({ label: plain, stamp: "sole" }), `p=${plain}`);
  assert.equal(formatPageName({ label: "A 1", stamp: "sole" }), "p=A%201");
  assert.equal(formatPageName({ label: "1(a)", stamp: "sole" }), "p=1%28a%29");
  assert.equal(formatPageName({ label: "a&b", stamp: "sole" }), "p=a%26b");
  assert.equal(formatPageName({ label: "ü", stamp: "sole" }), "p=%C3%BC");
  // Every one reads back as itself.
  for (const label of ["A 1", "1(a)", "a&b", "ü", "x+y", "it's", "Ω*"]) {
    const [name, value] = formatPageName({ label, stamp: "sole" }).split("=");
    assert.equal(name, "p");
    assert.deepEqual(pageNameOf("p", value), { label }, label);
  }
});

test("v= stamps the page before it, and is ignored anywhere else", () => {
  assert.deepEqual(pageFromHash("#sheet=50&v=2"), { sheet: 50, v: 2 });
  assert.deepEqual(pageFromHash("#p=49&v=3&text=a"), { label: "49", v: 3 });
  assert.deepEqual(pageFromHash("#page=50&v=1"), { sheet: 50, v: 1 });
  // After the page's text, it is still that page's.
  assert.deepEqual(pageFromHash("#sheet=50&text=a&v=2"), { sheet: 50, v: 2 });
  assert.deepEqual(pageFromHash("#sheet=50&zoom=200&v=2"), { sheet: 50, v: 2 });
  // Before any page, or after the next page, it stamps nothing here.
  assert.deepEqual(pageFromHash("#v=2&sheet=50"), { sheet: 50 });
  assert.deepEqual(pageFromHash("#sheet=50&text=a&sheet=51&v=2"), { sheet: 50 });
  // The first readable one is the stamp.
  assert.deepEqual(pageFromHash("#sheet=50&v=2&v=3"), { sheet: 50, v: 2 });
  assert.deepEqual(pageFromHash("#sheet=50&v=x&v=3"), { sheet: 50, v: 3 });
  // An unreadable page takes no stamp, and the next readable page takes its own.
  assert.deepEqual(pageFromHash("#sheet=x&v=2&sheet=7&v=4"), { sheet: 7, v: 4 });
});

test("a version stamp is digits from 1, and anything else is no stamp", () => {
  assert.equal(versionStampOf("1"), 1);
  assert.equal(versionStampOf("12"), 12);
  for (const value of ["", "0", "-1", "01", "2x", "1.5", " 2", "v2"]) assert.equal(versionStampOf(value), null, value);
  for (const hash of ["#sheet=5&v=0", "#sheet=5&v=", "#sheet=5&v=01", "#sheet=5&v=2x"]) assert.deepEqual(pageFromHash(hash), { sheet: 5 }, hash);
});

test("a writer puts the stamp straight after its page, and none for a file with one version", () => {
  assert.equal(formatPageName({ sheet: 50, stamp: 2 }), "sheet=50&v=2");
  assert.equal(formatPageName({ label: "49", stamp: 1 }), "p=49&v=1");
  assert.equal(formatPageName({ label: "A 1", stamp: 3 }), "p=A%201&v=3");
  assert.equal(formatPageName({ sheet: 50, stamp: "sole" }), "sheet=50");
  // What it writes reads back as the page and its stamp.
  assert.deepEqual(pageFromHash(`#${formatPageName({ sheet: 50, stamp: 2 })}`), { sheet: 50, v: 2 });
  assert.deepEqual(pageFromHash(`#${formatPageName({ label: "xii", stamp: 4 })}`), { label: "xii", v: 4 });
});

test("a fragment read on a version's own address is stamped for another address", () => {
  assert.equal(stampFragment("#sheet=49", 2), "sheet=49&v=2");
  assert.equal(stampFragment("sheet=49&text=a,b", 2), "sheet=49&v=2&text=a,b");
  assert.equal(stampFragment("p=49&text=a&p=50&text=b", 3), "p=49&v=3&text=a&p=50&v=3&text=b");
  // A page with a stamp of its own keeps it, wherever it stands.
  assert.equal(stampFragment("sheet=49&v=1&text=a&sheet=50&text=b", 2), "sheet=49&v=1&text=a&sheet=50&v=2&text=b");
  assert.equal(stampFragment("sheet=49&text=a&v=1", 2), "sheet=49&text=a&v=1");
  // Everything else is as written: an unreadable page takes none, and a card's name has none to take.
  assert.equal(stampFragment("sheet=x&text=a", 2), "sheet=x&text=a");
  assert.equal(stampFragment("zoom=200&page=7", 2), "zoom=200&page=7&v=2");
  assert.equal(stampFragment("ada-lovelace-2026-10-04-12-00-00", 2), "ada-lovelace-2026-10-04-12-00-00");
});
