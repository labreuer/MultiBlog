import assert from "node:assert/strict";
import { test } from "node:test";
import { normalisePageText, type PdfTextItemLike } from "./pdf-text";

// docs/PDF.md §3. What matters is that a dropped character leaves the offset
// map exact: every character of the output still names the source character it
// came from, or the quads recovered from a stored range land somewhere else.

// One 10pt item on a single baseline, starting at `x`; width by character count.
function item(str: string, x: number): PdfTextItemLike {
  return { str, transform: [10, 0, 0, 10, x, 100], width: str.length * 5, height: 10 };
}

// Every output character that isn't an inserted separator reads as its source.
function assertOffsetsExact(items: readonly PdfTextItemLike[], text: string, offsets: { itemIndex: number; charOffset: number }[]) {
  assert.equal(offsets.length, text.length);
  offsets.forEach(({ itemIndex, charOffset }, i) => {
    const source = items[itemIndex].str[charOffset];
    if (source === undefined || /\s/.test(source)) {
      assert.match(text[i], /\s/, `text[${i}] maps past its item or onto whitespace but reads "${text[i]}"`);
    } else {
      assert.equal(text[i], source, `text[${i}]`);
    }
  });
}

test("NULs between words are dropped and the spaces around them fold to one", () => {
  // JSTOR's stamped download footer: the gap before the IP address extracts
  // as NULs separated by spaces.
  const items = [item("This content downloaded from ", 0), item("\u0000 \u0000 \u0000 \u0000", 150), item("128.120.218.50", 200)];
  const { text, offsets } = normalisePageText(items);
  assert.equal(text, "This content downloaded from 128.120.218.50");
  assertOffsetsExact(items, text, offsets);
});

test("a NUL inside a word is dropped without a space in its place", () => {
  const items = [item("ab\u0000cd", 0)];
  const { text, offsets } = normalisePageText(items);
  assert.equal(text, "abcd");
  assert.deepEqual(
    offsets.map((o) => o.charOffset),
    [0, 1, 3, 4],
  );
});

test("every C0 control other than whitespace, and DEL, is dropped", () => {
  const controls = [...Array(0x20).keys()]
    .filter((code) => code < 0x09 || code > 0x0d)
    .map((code) => String.fromCharCode(code))
    .join("");
  const items = [item(`x${controls}\u007Fy`, 0)];
  const { text, offsets } = normalisePageText(items);
  assert.equal(text, "xy");
  assertOffsetsExact(items, text, offsets);
});

test("tab, LF, VT, FF and CR still fold as whitespace rather than vanishing", () => {
  const items = [item("a\tb\nc\u000Bd\u000Ce\rf", 0)];
  assert.equal(normalisePageText(items).text, "a b c d e f");
});

test("a page that is nothing but controls normalises to empty", () => {
  const { text, offsets } = normalisePageText([item("\u0000\u0000", 0)]);
  assert.equal(text, "");
  assert.deepEqual(offsets, []);
});
