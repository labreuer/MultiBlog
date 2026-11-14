import { test } from "node:test";
import assert from "node:assert/strict";
import { formatPageName, pageFromHash, pageNameOf } from "./pdf-open-params";

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
  assert.equal(formatPageName({ sheet: 5 }), "sheet=5");
  assert.deepEqual(pageFromHash(`#${formatPageName({ sheet: 5 })}`), { sheet: 5 });
  for (const plain of ["49", "xii", "A-1", "B.3"]) assert.equal(formatPageName({ label: plain }), `p=${plain}`);
  assert.equal(formatPageName({ label: "A 1" }), "p=A%201");
  assert.equal(formatPageName({ label: "1(a)" }), "p=1%28a%29");
  assert.equal(formatPageName({ label: "a&b" }), "p=a%26b");
  assert.equal(formatPageName({ label: "ü" }), "p=%C3%BC");
  // Every one reads back as itself.
  for (const label of ["A 1", "1(a)", "a&b", "ü", "x+y", "it's", "Ω*"]) {
    const [name, value] = formatPageName({ label }).split("=");
    assert.equal(name, "p");
    assert.deepEqual(pageNameOf("p", value), { label }, label);
  }
});
