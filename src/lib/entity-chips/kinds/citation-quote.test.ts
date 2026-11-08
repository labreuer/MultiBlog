import { test } from "node:test";
import assert from "node:assert/strict";
import type { JSONContent } from "@tiptap/core";
import { flattenForMatch } from "../../comment-quote-match";
import { planEdits } from "../../doc-edit";
import { markdownToBlocks, markdownToText } from "../../markdown-import";
import { resolveQuote, type QuoteSpec } from "../../quote-resolve";
import { pmDocContentSchema } from "../../tiptap-schema";
import { chipsForFinding } from "../placeholders";
import { chipMarkdowns, chipsIn } from "../renderings";
import { chipLabelsIn } from "../text";
import type { ChipInputs } from "../types";
import { CITATION, type CitationContext, type CitedWork } from "./citation";
import { MENTION, type MentionUser } from "./mention";

// docs/ENTITY_CHIPS.md, MCP items 3 and 6 — a quote that gives a citation in
// Pandoc's syntax, as a Markdown read writes it, finds that citation by what
// it cites, whatever its label; its other fields decide among several, are
// reported when the one it found holds others, and refuse an edit.

const work = (id: string, key: string, short: string | null, names: string, year: number): CitedWork => ({
  id,
  key,
  short,
  names,
  year,
  title: key,
  deleted: false,
  entry: { authors: names, year: String(year), title: key, titleIsContainer: true, source: "" },
});
const CONTEXT: CitationContext = {
  bu: work("bu", "barfield1957", "BU", "Barfield", 1957),
  radner: work("radner", "radner2012", null, "Radner", 2012),
};
const ADA: MentionUser = { id: "u1", name: "Ada Lovelace", initials: "", slug: "ada", deleted: false, botOf: null };
const INPUTS: ChipInputs = { styles: {}, context: { [CITATION]: CONTEXT, [MENTION]: { u1: ADA } } };
const KEYS: Record<string, string> = { barfield1957: "bu", radner2012: "radner" };

const cite = (iid: string, refId: string, more: Record<string, unknown> = {}): JSONContent => ({
  type: "entityChip",
  attrs: { kind: CITATION, iid, data: { items: [{ refId, ...more }] } },
});
const mention = (iid: string, userId: string): JSONContent => ({ type: "entityChip", attrs: { kind: MENTION, iid, data: { userId } } });
const text = (value: string): JSONContent => ({ type: "text", text: value });
const para = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });

const DOC = pmDocContentSchema.nodeFromJSON({
  type: "doc",
  content: [
    para(text("Appearances are collective "), cite("c1", "bu", { locator: "50" }), text(".")),
    para(text("Ideas have an origin "), cite("c2", "radner", { locator: "49" }), text(", and so do appearances "), cite("c3", "bu", { locator: "60" }), text(".")),
    para(text("Ask "), mention("m1", "u1"), text(" about it.")),
  ],
});
const LABELS = chipLabelsIn(DOC, INPUTS);
const MARKDOWN = chipMarkdowns(chipsIn(DOC), INPUTS.styles, INPUTS.context);
const TARGET = flattenForMatch(DOC, LABELS);

/** A spec as `withQuoteChips` makes one, with the library's keys looked up here. */
function spec(quote: string, more: Omit<QuoteSpec, "quote" | "chips"> = {}): QuoteSpec {
  const parts = { quote, ...more };
  const chips: NonNullable<QuoteSpec["chips"]> = {};
  for (const [name, value] of Object.entries(parts) as [keyof typeof parts, string][]) {
    const blocks = markdownToBlocks(value, { chips: true });
    chips[name] = chipsForFinding(blocks, { user: (slug) => (slug === "ada" ? "u1" : undefined), reference: (key) => KEYS[key] }) ?? blocks;
  }
  return { ...parts, chips };
}
const found = (quote: QuoteSpec) => {
  const resolution = resolveQuote(TARGET, quote, markdownToText);
  return resolution.kind === "found" ? resolution.matches : [];
};

test("a citation quoted in its Markdown finds its chip, whatever label the doc shows", () => {
  assert.equal(LABELS.get("c1"), "(BU p. 50)");
  const [match, ...others] = found(spec("Appearances are collective [@barfield1957, p. 50]."));
  assert.equal(others.length, 0);
  assert.equal(match.chipsDiffer, undefined);
  assert.equal(match.from, 1);
  // Its label still finds it, as written.
  assert.equal(found({ quote: "Appearances are collective (BU p. 50)." }).length, 1);
  // So does a quote that is Markdown without a citation in it.
  assert.equal(found(spec("Ask [@Ada Lovelace](/authors/ada) about it.")).length, 1);
  // And one the chip parse misreads, an `@` before a name being a citation's
  // syntax, falls back to its plain parse's text.
  const misread = spec("**Ask** @Ada Lovelace about it.");
  assert.ok(misread.chips);
  assert.equal(found(misread).length, 1);
});

test("of several chips citing one work, the one whose page agrees wins; none agreeing is ambiguous", () => {
  const p60 = found(spec("[@barfield1957, p. 60]"));
  assert.equal(p60.length, 1);
  assert.equal(MARKDOWN.get(chipsIn(DOC).find((chip) => chip.pos === p60[0].from)!.iid), "[@barfield1957, p. 60]");
  assert.equal(found(spec("[@barfield1957, p. 99]")).length, 2);
  // Context tells two apart as for any repeated passage.
  assert.equal(found(spec("[@barfield1957, p. 99]", { prefix: "collective" })).length, 1);
});

test("one chip that fits with another page is found, and marked", () => {
  const [match, ...others] = found(spec("Ideas have an origin [@radner2012, p. 48]"));
  assert.equal(others.length, 0);
  assert.equal(match.chipsDiffer, true);
  // A key that names no work finds nothing, and the near misses come from the text read.
  const missed = resolveQuote(TARGET, spec("Ideas have an origin [@nobody2000]"), markdownToText);
  assert.equal(missed.kind, "none");
});

test("an edit whose quote gives a chip other fields than it holds is chip_changed, with what it holds now", () => {
  const plan = (quote: QuoteSpec) =>
    planEdits(DOC, [{ kind: "replace", target: quote, blocks: markdownToBlocks("Ideas have a source") }], {
      schema: pmDocContentSchema,
      authorId: null,
      asText: markdownToText,
      labels: LABELS,
      chipMarkdown: MARKDOWN,
    });
  const stale = plan(spec("Ideas have an origin [@radner2012, p. 48]"));
  assert.ok(!stale.ok);
  assert.equal(stale.refusal.code, "chip_changed");
  assert.deepEqual(stale.refusal.details?.chips, ["[@radner2012, p. 49]"]);
  // Quoting it as it is now edits it.
  const current = plan(spec("Ideas have an origin [@radner2012, p. 49]"));
  assert.ok(current.ok);
  assert.equal(current.next.child(1).textContent.startsWith("Ideas have a source, and so do"), true);
});
