import { test } from "node:test";
import assert from "node:assert/strict";
import { Lexer, type Token } from "marked";
import { inlineRuns, runsText, type InlineMark, type InlineRun } from "./inline-markdown";

// docs/CITATIONS.md, "Markdown inside a citation" — the citation's own small
// inline parser, held to marked's reading of the same text, which is what
// the rest of the app's Markdown goes through, except where marked departs
// from CommonMark.

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
const decode = (text: string) => text.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity]);

/** marked's inline tokens as runs, with what this parser doesn't read (links, HTML) kept as their source. */
function markedRuns(markdown: string): InlineRun[] {
  const runs: InlineRun[] = [];
  const add = (text: string, marks: InlineMark[]) => {
    if (!text) return;
    const ordered = (["bold", "italic", "strike", "code"] as InlineMark[]).filter((mark) => marks.includes(mark));
    const last = runs.at(-1);
    if (last && (last.marks ?? []).join() === ordered.join()) last.text += text;
    else runs.push(ordered.length > 0 ? { text, marks: ordered } : { text });
  };
  const walk = (tokens: Token[], marks: InlineMark[]) => {
    for (const token of tokens) {
      const nested = "tokens" in token && Array.isArray(token.tokens) ? token.tokens : null;
      if (token.type === "em" && nested) walk(nested, marks.includes("italic") ? marks : [...marks, "italic"]);
      else if (token.type === "strong" && nested) walk(nested, marks.includes("bold") ? marks : [...marks, "bold"]);
      else if (token.type === "del" && nested) walk(nested, marks.includes("strike") ? marks : [...marks, "strike"]);
      else if (token.type === "codespan") add(decode(token.text), [...marks, "code"]);
      else if (token.type === "text" || token.type === "escape") add(decode(token.text), marks);
      else add(token.raw, marks);
    }
  };
  walk(new Lexer({ gfm: true }).inlineTokens(markdown), []);
  return runs;
}

const CASES = [
  "see *especially*",
  "see _especially_",
  "**strong** and *em*",
  "***both***",
  "*em **strong inside** em*",
  "**strong *em inside* strong**",
  "~~struck~~ text",
  "`code *not em*`",
  "`` a ` b ``",
  "snake_case_name stays",
  "a * b * c",
  "**unclosed",
  "*a**b*",
  "2*3*4",
  "\\*escaped\\*",
  "\\\\*em*",
  "a*\"quoted\"*b",
  "*(parenthesised)*",
  "emphasis added",
  "p. 49, *emphasis added*",
  "trans. **K.** Smith",
  "**a**b**c**",
  "_a_b",
  "*a*_b_",
  "text ` unclosed code",
  "*em* `code` **strong** ~~del~~ plain",
];

test("inline runs: the same as marked's reading", () => {
  for (const markdown of CASES) assert.deepEqual(inlineRuns(markdown), markedRuns(markdown), markdown);
});

test("inline runs: CommonMark's answer where marked's differs, as commonmark.js gives it", () => {
  // The rule of three: a run that can both open and close doesn't pair with one whose length makes a multiple of three.
  assert.deepEqual(inlineRuns("a*a** a("), [{ text: "a*a** a(" }]);
  // `**` opens, `*` closes after punctuation, and one of the opener's two is left over.
  assert.deepEqual(inlineRuns("\\\\ **(*"), [{ text: "\\ *" }, { text: "(", marks: ["italic"] }]);
});

test("inline runs: what isn't emphasis, strong, strikethrough or code is text", () => {
  // marked reads these as a link and as HTML; in a chip they are words.
  assert.deepEqual(inlineRuns("[a page](https://x.com)"), [{ text: "[a page](https://x.com)" }]);
  assert.deepEqual(inlineRuns("<b>bold</b>"), [{ text: "<b>bold</b>" }]);
  // A single tilde is Pandoc's subscript, not a strike.
  assert.deepEqual(inlineRuns("H~2~O"), [{ text: "H~2~O" }]);
  assert.equal(runsText(inlineRuns("see *especially* `this`")), "see especially this");
});
