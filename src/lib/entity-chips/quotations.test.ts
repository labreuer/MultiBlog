import { test } from "node:test";
import assert from "node:assert/strict";
import type { JSONContent } from "@tiptap/core";
import { pmDocContentSchema } from "../tiptap-schema";
import { CITATION, citationKind, type CitationContext, type CitedWork } from "./kinds/citation";
import { MENTION } from "./kinds/mention";
import { chipRenderings, chipsIn, chipsInJSON } from "./renderings";
import { DEFAULT_CHIP_STYLES } from "./types";

// docs/CITATIONS.md, "What quote:prev and quote:next find" — the one finder,
// over a doc's nodes and its JSON alike, and the link a citation then has.

const text = (value: string): JSONContent => ({ type: "text", text: value });
const para = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });
const quote = (...content: JSONContent[]): JSONContent => ({ type: "blockquote", content });
const cite = (iid: string, referent?: string, locator = "49", refId = "bu"): JSONContent => ({
  type: "entityChip",
  attrs: { kind: CITATION, iid, data: { items: [{ refId, locator }], ...(referent ? { referent } : {}) } },
});
const mention = (iid: string): JSONContent => ({ type: "entityChip", attrs: { kind: MENTION, iid, data: { userId: "u1" } } });
const doc = (...content: JSONContent[]): JSONContent => ({ type: "doc", content });

/** Each chip's quotation by instance id, over the doc's nodes, checked against its JSON; and what the positions cover. */
function quotations(json: JSONContent): Record<string, string | null | undefined> {
  const node = pmDocContentSchema.nodeFromJSON(json);
  const fromNode = chipsIn(node);
  const fromJSON = chipsInJSON(json);
  const out: Record<string, string | null | undefined> = {};
  fromNode.forEach((chip, index) => {
    const quotation = chip.quotation;
    assert.equal(fromJSON[index].quotation?.text, quotation?.text, `JSON agrees for ${chip.iid}`);
    // The positions cover the words, give or take the space and punctuation the text trims.
    if (quotation && quotation.from !== null && quotation.to !== null) {
      const covered = node.textBetween(quotation.from, quotation.to, " ", "￼").replaceAll("￼", " ").replace(/\s+/g, " ").trim();
      assert.equal(covered, quotation.text.replace(/\s+/g, " "), `positions of ${chip.iid}`);
    }
    out[chip.iid] = quotation === undefined ? undefined : (quotation?.text ?? null);
  });
  return out;
}

test("quote:prev is the double-quoted run just before, over spaces, closing punctuation and citations", () => {
  assert.deepEqual(quotations(doc(para(text('Barfield writes "could not yet call his soul his own" '), cite("a", "quote:prev")))), { a: "could not yet call his soul his own" });
  assert.deepEqual(quotations(doc(para(text('"his soul his own." '), cite("a", "quote:prev"), text(" and on.")))), { a: "his soul his own." });
  assert.deepEqual(quotations(doc(para(text("“his soul his own”, "), cite("a", "quote:prev")))), { a: "his soul his own" });
  // A quotation within the quotation is its own business.
  assert.deepEqual(quotations(doc(para(text('"he said ‘no’ to it" '), cite("a", "quote:prev")))), { a: "he said ‘no’ to it" });
  // Two citations share one quotation.
  assert.deepEqual(quotations(doc(para(text('"his own" '), cite("a", "quote:prev"), text(" "), cite("b", "quote:prev", "211", "sa")))), {
    a: "his own",
    b: "his own",
  });
});

test("quote:prev finds nothing past a word or another kind of chip", () => {
  assert.deepEqual(quotations(doc(para(text('"his own" says Barfield '), cite("a", "quote:prev")))), { a: null });
  assert.deepEqual(quotations(doc(para(text('"his own" '), mention("m"), text(" "), cite("a", "quote:prev")))), { m: undefined, a: null });
  assert.deepEqual(quotations(doc(para(text("no quotation at all "), cite("a", "quote:prev")))), { a: null });
});

test("quote:prev is the blockquote a chip ends, or stands alone right after", () => {
  const block = quote(para(text("could not yet call")), para(text("his soul his own. "), cite("a", "quote:prev")));
  assert.deepEqual(quotations(doc(block)), { a: "could not yet call his soul his own." });
  // Alone in the paragraph after it, with only punctuation and citations beside it.
  assert.deepEqual(quotations(doc(quote(para(text("could not yet call his soul his own."))), para(text("("), cite("a", "quote:prev"), text(")")))), {
    a: "could not yet call his soul his own.",
  });
  // Not alone, and not at the blockquote's end: no blockquote.
  assert.deepEqual(quotations(doc(quote(para(text("his soul"))), para(text("see "), cite("a", "quote:prev")))), { a: null });
  assert.deepEqual(quotations(doc(quote(para(text("his soul "), cite("a", "quote:prev"), text(" and more words"))))), { a: null });
});

test("quote:next is the first quotation after it, before the next citation, or the blockquote after its paragraph", () => {
  assert.deepEqual(quotations(doc(para(cite("a", "quote:next"), text(' writes that "could not yet call his soul his own".')))), { a: "could not yet call his soul his own" });
  // A citation between stops it, and the next one has it.
  assert.deepEqual(quotations(doc(para(cite("a", "quote:next"), text(" and "), cite("b", "quote:next"), text(' say "his own"')))), { a: null, b: "his own" });
  assert.deepEqual(quotations(doc(para(cite("a", "quote:next"), text(" writes:")), quote(para(text("could not yet")), para(text("call his soul."))))), {
    a: "could not yet call his soul.",
  });
});

test("a chip pointing at nothing carries no quotation, and a nested one is found where it is", () => {
  assert.deepEqual(quotations(doc(para(text('"his own" '), cite("a"), text(" "), cite("b", "/link/x")))), { a: undefined, b: undefined });
  const list: JSONContent = { type: "bulletList", content: [{ type: "listItem", content: [para(text('"in a list" '), cite("a", "quote:prev"))] }] };
  assert.deepEqual(quotations(doc(para(text("before")), list)), { a: "in a list" });
});

const work = (id: string, key: string): CitedWork => ({
  id,
  key,
  short: "BU",
  names: "Barfield",
  year: 1957,
  title: "Saving the Appearances",
  deleted: false,
  entry: { authors: "Barfield", year: "1957", title: "Saving the Appearances", titleIsContainer: true, source: "" },
});
const CONTEXT: CitationContext = { bu: work("bu", "barfield1957"), sa: work("sa", "sa1990") };
const hrefs = (json: JSONContent) => chipRenderings(chipsInJSON(json), DEFAULT_CHIP_STYLES, { [CITATION]: CONTEXT }).map((rendering) => rendering.href);

test("the link: a quotation goes as the route's text, shortened run by run unless the locator names several pages", () => {
  assert.deepEqual(hrefs(doc(para(text('"could not yet call … his own" '), cite("a", "quote:prev")))), ["/references/barfield1957/p/49?text=could+not+yet+call...his+own"]);
  const long = '"It is a direction in which we had all better be moving, rather than a beatific consummation" ';
  assert.deepEqual(hrefs(doc(para(text(long), cite("a", "quote:prev")))), ["/references/barfield1957/p/49?text=It+is+a,a+beatific+consummation"]);
  // Several pages: the locator is the path, and the runs go whole.
  assert.deepEqual(hrefs(doc(para(text(long), cite("a", "quote:prev", "49–50")))), [
    `/references/barfield1957/p/${encodeURIComponent("49–50")}?text=It+is+a+direction+in+which+we+had+all+better+be+moving+rather+than+a+beatific+consummation`,
  ]);
  // A bracket attached to a word keeps its brackets; one standing alone is a gap.
  assert.deepEqual(hrefs(doc(para(text('"[T]he soul [sic] his own" '), cite("a", "quote:prev")))), ["/references/barfield1957/p/49?text=%5BT%5Dhe+soul...his+own"]);
  // Nothing found: the page, as with no referent.
  assert.deepEqual(hrefs(doc(para(text("no quotation "), cite("a", "quote:prev")))), ["/references/barfield1957/p/49"]);
});

test("the link: a /pdf/ passage goes through the route as its pairs, and a link elsewhere as itself", () => {
  assert.deepEqual(hrefs(doc(para(cite("a", "/pdf/saving-the-appearances#zoom=200&p=49&text=a+b...c&page=54&text=d")))), [
    "/references/barfield1957/p/49?p=49&text=a+b...c&page=54&text=d",
  ]);
  assert.deepEqual(hrefs(doc(para(cite("a", "/pdf/saving-the-appearances")))), ["/references/barfield1957/p/49"]);
  assert.deepEqual(hrefs(doc(para(cite("a", "/link/abc123"), text(" "), cite("b", "https://example.com/x")))), ["/link/abc123", "https://example.com/x"]);
  // The post's link is the doc's.
  const [rendering] = chipRenderings(chipsInJSON(doc(para(text('"his own" '), cite("a", "quote:prev")))), DEFAULT_CHIP_STYLES, { [CITATION]: CONTEXT });
  assert.equal(rendering.postHref, rendering.href);
});

test("a chip with no body around it links to its page", () => {
  const [chip] = chipsInJSON(doc(para(text('"his own" '), cite("a", "quote:prev"))));
  const { quotation: _found, ...bare } = chip;
  void _found;
  assert.deepEqual(chipRenderings([bare], DEFAULT_CHIP_STYLES, { [CITATION]: CONTEXT })[0].href, "/references/barfield1957/p/49");
  // And the kind renders from what it is handed, reading no doc.
  assert.equal(citationKind.render([{ items: [{ refId: "bu", locator: "49" }], referent: "quote:prev" }], { form: "short" }, CONTEXT, [{ quotation: "his own" }])[0].href, "/references/barfield1957/p/49?text=his+own");
});
