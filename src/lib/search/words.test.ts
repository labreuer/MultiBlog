import { test } from "node:test";
import assert from "node:assert/strict";
import { correctableWords, lexemeLiteral, splitLastWord } from "./words";

// docs/FULLTEXT.md §5. Typo correction rewrites what the reader typed, so
// what it may touch is the rule worth pinning: never a quoted phrase, never
// a negated word, never an operator, never a short word.

test("plain words of four or more characters qualify", () => {
  assert.deepEqual(correctableWords("macintire virtue ethics"), ["macintire", "virtue", "ethics"]);
  assert.deepEqual(correctableWords("the cat sat"), []);
  assert.deepEqual(correctableWords("Gödel"), ["Gödel"]);
});

test("quoted phrases, negated words and `or` don't", () => {
  assert.deepEqual(correctableWords('"after virtue" macintire'), ["macintire"]);
  assert.deepEqual(correctableWords('wittgenstien -tractatus'), ["wittgenstien"]);
  assert.deepEqual(correctableWords("institution or instituion"), ["institution", "instituion"]);
  assert.deepEqual(correctableWords("OR word"), ["word"]);
  // An unclosed quote runs to the end, as websearch_to_tsquery reads it.
  assert.deepEqual(correctableWords('kant "categorical imperitive'), ["kant"]);
});

test("punctuation splits a token, and each piece is judged alone", () => {
  assert.deepEqual(correctableWords("macintire, virtue."), ["macintire", "virtue"]);
  assert.deepEqual(correctableWords("e-mail correspondance"), ["mail", "correspondance"]);
  assert.deepEqual(correctableWords("wittgenstein's"), ["wittgenstein"]);
});

test("a repeated word is corrected once", () => {
  assert.deepEqual(correctableWords("virtue virtue"), ["virtue"]);
});

test("a lexeme literal survives quotes and backslashes", () => {
  assert.equal(lexemeLiteral("macintyr"), "'macintyr'");
  assert.equal(lexemeLiteral("o'brien"), "'o''brien'");
  assert.equal(lexemeLiteral("a\\b"), "'a\\\\b'");
});

test("the last word is split off only while it is being typed", () => {
  assert.deepEqual(splitLastWord("mediating institu"), { rest: "mediating ", last: "institu" });
  assert.deepEqual(splitLastWord("organiza"), { rest: "", last: "organiza" });
  // Finished with a space: nothing is being typed.
  assert.deepEqual(splitLastWord("mediating "), { rest: "mediating ", last: "" });
  // Inside an open quote, or negated: a prefix would change the question.
  assert.deepEqual(splitLastWord('"after vir'), { rest: '"after vir', last: "" });
  assert.deepEqual(splitLastWord("kant -categ"), { rest: "kant -categ", last: "" });
  assert.deepEqual(splitLastWord(""), { rest: "", last: "" });
});
