import { test } from "node:test";
import assert from "node:assert/strict";
import { checkWikiName, normalizeWikiName, WIKI_NAME_MAX_BYTES } from "./wiki-name";

// docs/WIKI.md "What a name may hold" — the table of what a name may be:
// each normalizing step and its order, each refusal with its message, and
// what is allowed. The doc_wiki_name_valid CHECK holds stored names to the
// same rules; e2e/wiki.spec.ts checks the two agree on a sample of these.

const ok = (input: string) => {
  const result = checkWikiName(input);
  assert.ok(result.ok, `expected ${JSON.stringify(input)} to be accepted, got ${JSON.stringify(result)}`);
  return result.name;
};
const refused = (input: string, message: RegExp) => {
  const result = checkWikiName(input);
  assert.ok(!result.ok, `expected ${JSON.stringify(input)} to be refused`);
  assert.match(result.message, message);
};

test("spaces fold: _, runs, the Unicode spaces, and the ends trimmed", () => {
  assert.equal(normalizeWikiName("Mercury_(planet)"), "Mercury (planet)");
  assert.equal(normalizeWikiName("  a __ b\u00A0\u3000c  "), "a b c");
  for (const space of ["\u1680", "\u180E", "\u2000", "\u200A", "\u2028", "\u2029", "\u202F", "\u205F"]) {
    assert.equal(normalizeWikiName(`a${space}b`), "a b", `U+${space.codePointAt(0)!.toString(16)}`);
  }
});

test("bidi marks are stripped, and zero-width characters are not", () => {
  assert.equal(normalizeWikiName("\u200Eabc\u202A\u202E\u200F"), "abc");
  assert.equal(normalizeWikiName("a\u200Bb\u200Cc\u200Dd"), "a\u200Bb\u200Cc\u200Dd");
  assert.equal(normalizeWikiName("a\u2066b\u2069"), "a\u2066b\u2069");
});

test("NFC comes last: a mark stripped from between a letter and its accent leaves them composed", () => {
  assert.equal(normalizeWikiName("Cafe\u200E\u0301"), "Caf\u00E9");
  assert.equal(normalizeWikiName("Cafe\u0301"), "Caf\u00E9");
});

test("a name keeps the capitals it was given", () => {
  assert.equal(ok("mercury (PLANET)"), "mercury (PLANET)");
  assert.equal(ok("Straße"), "Straße");
});

test("what is allowed: any script, digits, punctuation, symbols, a bare % and a bare &", () => {
  for (const name of [
    "Mercury (planet)",
    "World War 2",
    "100% pure",
    "R&D (lab)",
    "C++",
    "a=b; c,d! e* f' g$ h@ i:",
    "Ὀδυσσεύς",
    "東京",
    "ΐ",
    "x.rsc.y",
    "x.rs",
    "...",
    "a\u0085b",
    "\uE000",
  ]) {
    ok(name);
  }
});

test("refused: empty, after normalizing", () => {
  refused("", /empty/);
  refused(" _\u200E ", /empty/);
});

test("refused: a string that isn't well formed", () => {
  refused("a\uD800b", /broken/);
  refused("a\uDC00", /broken/);
  refused("a\uFFFD", /broken/);
});

test("refused: C0 controls and DEL", () => {
  refused("a\u0000b", /control/);
  refused("a\u0009b", /control/);
  refused("a\u001Fb", /control/);
  refused("a\u007Fb", /control/);
});

test("refused: what MediaWiki's set leaves out, naming the character", () => {
  for (const ch of ["#", "<", ">", "[", "]", "{", "}", "|"]) refused(`a${ch}b`, new RegExp(`"\\${ch}"`));
});

test("refused here and allowed by MediaWiki: / \\ ? ~", () => {
  refused("a/b", /split its URL/);
  refused("a\\b", /reads as "\/"/);
  refused("Why?", /query string/);
  refused("a~b", /variant/);
});

test("refused: what looks already encoded", () => {
  refused("a%2Fb", /already encoded/);
  refused("100%ff", /already encoded/);
  refused("&amp;", /HTML entity/);
  refused("x &lt; y", /HTML entity/);
  refused("x &#38; y", /"#"/);
  refused("&é;", /HTML entity/);
  ok("& x;");
  ok("&;");
});

test("refused: the dot segments, which a browser resolves away", () => {
  refused(".", /"\."/);
  refused("..", /"\.\."/);
  refused(" . ", /"\."/);
});

test("refused: more than 255 bytes of UTF-8", () => {
  ok("a".repeat(WIKI_NAME_MAX_BYTES));
  refused("a".repeat(WIKI_NAME_MAX_BYTES + 1), /256/);
  ok("é".repeat(127)); // 254 bytes
  refused("é".repeat(128), /256/);
});

test("refused: unbalanced parentheses", () => {
  refused("Smile :)", /balanced/);
  refused("a (b", /balanced/);
  refused(")(", /balanced/);
  ok("(a) (b (c))");
});

test("refused: a final .rsc, in any capitals", () => {
  refused("x.rsc", /\.rsc/);
  refused("x.RSC", /\.rsc/);
  refused(".Rsc", /\.rsc/);
});
