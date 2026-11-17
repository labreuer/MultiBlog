import { test } from "node:test";
import assert from "node:assert/strict";
import { diffText, tokenizeFine, TooLargeToMerge, WORD_DIFF_MAX_CELLS } from "./diff";

// The word diff's size cap (docs/MCP.md §6, "Size guards"): a pair past it is
// trimmed to its changed middle first; a read past it even then gets the
// middle replaced whole, and an edit is refused.

/** `count` distinct words, `w0 w1 …`, with `first` and `last` in place of the ends when given. */
function words(count: number, ends: { first?: string; last?: string } = {}): string {
  const list = Array.from({ length: count }, (_, i) => `w${i}`);
  if (ends.first) list[0] = ends.first;
  if (ends.last) list[count - 1] = ends.last;
  return list.join(" ");
}

const render = (tokens: ReturnType<typeof diffText>) =>
  tokens.map((t) => (t.type === "equal" ? t.value : t.type === "delete" ? `[-${t.value}-]` : `{+${t.value}+}`)).join("");

test("a pair past the cap whose shared ends trim it under is diffed word by word", () => {
  // 2,100 words and the spaces between them are ~4,200 tokens a side: 17M cells.
  const old = words(2100);
  const next = old.replace(" w1050 ", " changed ");
  assert.ok(2 * 2100 * 2 * 2100 > WORD_DIFF_MAX_CELLS);
  const tokens = diffText(old, next);
  assert.equal(render(tokens), old.replace(" w1050 ", " [-w1050-]{+changed+} "));
  assert.deepEqual(diffText(old, next, undefined, "edit"), tokens);
});

test("a pair past the cap even after trimming: a read gets its middle replaced whole, an edit is refused", () => {
  const old = words(2100);
  const next = words(2100, { first: "start", last: "end" });
  const tokens = diffText(old, next);
  assert.deepEqual(tokens, [
    { value: old, type: "delete" },
    { value: next, type: "insert" },
  ]);
  assert.throws(() => diffText(old, next, undefined, "edit"), TooLargeToMerge);

  // Shared ends stay equal around the replaced middle.
  const framedOld = `alpha beta ${old} omega`;
  const framedNew = `alpha beta ${next} omega`;
  const framed = diffText(framedOld, framedNew, tokenizeFine);
  assert.deepEqual(framed.slice(0, 4), ["alpha", " ", "beta", " "].map((value) => ({ value, type: "equal" })));
  assert.deepEqual(framed.slice(-2), [" ", "omega"].map((value) => ({ value, type: "equal" })));
  assert.equal(render(framed), `alpha beta [-${old}-]{+${next}+} omega`);
});

test("under the cap nothing is trimmed, so the answer is the plain LCS's", () => {
  // Of two equal words, the LCS keeps the first; trimming the end first would keep the second.
  assert.equal(render(diffText("a a", "a")), "a[- -][-a-]");
});
