import { test } from "node:test";
import assert from "node:assert/strict";
import { FRAGMENT_DELIMITER as F, MATCH_START as S, MATCH_STOP as E, hasMatch, parseHeadline } from "./headline";

// docs/FULLTEXT.md §4. ts_headline's output is the user's own text with our
// delimiters in it, never escaped, so it is parsed into strings rather than
// trusted as markup — and the parse is what decides what lands in a <mark>.

test("plain text is one fragment of one unmatched part", () => {
  assert.deepEqual(parseHeadline("no match here"), [[{ text: "no match here", match: false }]]);
  assert.deepEqual(parseHeadline(""), []);
  assert.equal(hasMatch(parseHeadline("no match here")), false);
});

test("matches split out, with the space beside them kept", () => {
  assert.deepEqual(parseHeadline(`Kurt ${S}Gödel${E} was ${S}naïve${E}`), [
    [
      { text: "Kurt ", match: false },
      { text: "Gödel", match: true },
      { text: " was ", match: false },
      { text: "naïve", match: true },
    ],
  ]);
});

test("fragments split on the delimiter, and empty ones go", () => {
  const fragments = parseHeadline(`one ${S}a${E}${F}${F}  two ${S}b${E} `);
  assert.deepEqual(fragments, [
    [
      { text: "one ", match: false },
      { text: "a", match: true },
    ],
    [
      { text: "two ", match: false },
      { text: "b", match: true },
    ],
  ]);
  assert.equal(hasMatch(fragments), true);
});

test("block boundaries and runs of whitespace read as one space", () => {
  assert.deepEqual(parseHeadline(`end of one block\n\nstart of ${S}next${E}`), [
    [
      { text: "end of one block start of ", match: false },
      { text: "next", match: true },
    ],
  ]);
});

test("markup in the text stays text", () => {
  assert.deepEqual(parseHeadline(`<script>alert(1)</script> ${S}&amp;${E}`), [
    [
      { text: "<script>alert(1)</script> ", match: false },
      { text: "&amp;", match: true },
    ],
  ]);
});

test("an unclosed match runs to the end of its fragment only", () => {
  assert.deepEqual(parseHeadline(`a ${S}b c${F}d`), [
    [
      { text: "a ", match: false },
      { text: "b c", match: true },
    ],
    [{ text: "d", match: false }],
  ]);
});
