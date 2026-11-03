import { test } from "node:test";
import assert from "node:assert/strict";
import { flattenExtensions, type JSONContent } from "@tiptap/core";
import type { Schema } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import {
  annotationContentToMarkdown,
  commentContentToMarkdown,
  docContentToMarkdown,
  markdownToAnnotationContent,
  markdownToBlocks,
  markdownToCommentContent,
} from "./markdown-import";
import { orderedListPastePlugin, orderedListTokenizer, parsePlainTextOrderedList } from "./ordered-list-markers";
import {
  annotationContentExtensions,
  commentContentExtensions,
  contentExtensions,
  EDITOR_LINK_OPTIONS,
  ListItem,
  OrderedList,
  pmAnnotationContentSchema,
  pmCommentContentSchema,
  pmDocContentSchema,
  pmSchema,
  StarterKit,
} from "./tiptap-schema";

// docs/DOC_IMPORT.md §12 — which lines open an ordered list, through each of
// the three Markdown parsers; what the export writes for a list in each style
// and whether it reads back; and the editors' plain-text paste, which applies
// the same rule.

function text(node: JSONContent): string {
  return typeof node.text === "string" ? node.text : (node.content ?? []).map(text).join("");
}

// A block as a short string: `p:text`, or `ol(type,start)[item | item]`,
// an item's blocks joined by " + ". Newlines read as spaces, since the
// comment and annotation parses collapse a soft break and the doc's keeps it.
function shape(node: JSONContent): string {
  if (node.type === "paragraph") return `p:${text(node).replace(/\n/g, " ")}`;
  if (node.type === "orderedList") {
    const type = node.attrs?.type ?? "1";
    const start = node.attrs?.start ?? 1;
    const items = (node.content ?? []).map((item) => (item.content ?? []).map(shape).join(" + "));
    return `ol(${type},${start})[${items.join(" | ")}]`;
  }
  return node.type ?? "?";
}

const parsers: [string, (markdown: string) => JSONContent[]][] = [
  ["doc", (markdown) => markdownToBlocks(markdown)],
  ["comment", (markdown) => markdownToCommentContent(markdown).content ?? []],
  ["annotation", (markdown) => markdownToAnnotationContent(markdown).content ?? []],
];

const parseCases: [string, string, string[]][] = [
  // An initial or an abbreviation opening a paragraph is text.
  ["an initial", "N. T. Wright, who says it.", ["p:N. T. Wright, who says it."]],
  ["an initial that is a numeral", "C. S. Lewis wrote it.", ["p:C. S. Lewis wrote it."]],
  ["D, a numeral", "D. A. Carson wrote it.", ["p:D. A. Carson wrote it."]],
  ["I, Roman 1", "I. Howard Marshall wrote it.", ["p:I. Howard Marshall wrote it."]],
  ["cf.", "cf. Barth on this.", ["p:cf. Barth on this."]],
  ["St.", "St. Augustine said it.", ["p:St. Augustine said it."]],
  ["Dr.", "Dr. Jones said it.", ["p:Dr. Jones said it."]],
  ["Mr.", "Mr. Smith said it.", ["p:Mr. Smith said it."]],
  ["Ms.", "Ms. Smith said it.", ["p:Ms. Smith said it."]],
  ["No.", "No. 5 is next.", ["p:No. 5 is next."]],
  ["ok.", "ok. Next step.", ["p:ok. Next step."]],
  ["a verse", "v. 23 says so.", ["p:v. 23 says so."]],
  ["circa", "c. 1200 the church grew.", ["p:c. 1200 the church grew."]],
  ["a note", "n. 4 has it.", ["p:n. 4 has it."]],
  ["lower-case initials", "e. e. cummings wrote it.", ["p:e. e. cummings wrote it."]],
  ["a page", "p. 240 has it.", ["p:p. 240 has it."]],
  ["a letter and one space after a period", "a. one", ["p:a. one"]],
  ["two such lines", "a. one\nb. two", ["p:a. one b. two"]],
  ["a mixed-case numeral", "Iv) four", ["p:Iv) four"]],
  ["an invalid numeral", "iiii) four", ["p:iiii) four"]],
  ["two letters, alone", "aa) one", ["p:aa) one"]],
  ["two letters, not followed by the next", "aa) one\nac) two", ["p:aa) one ac) two"]],
  ["an initial mid-paragraph", "Text first\nN. T. Wright mid-paragraph", ["p:Text first N. T. Wright mid-paragraph"]],
  // Two such paragraphs stay two paragraphs, and one doesn't join a list above it.
  ["two after a blank line", "St. Augustine said it.\n\nN. T. Wright says it.", ["p:St. Augustine said it.", "p:N. T. Wright says it."]],
  ["one after a list and a blank line", "1. one\n\nN. T. Wright says it.", ["ol(1,1)[p:one]", "p:N. T. Wright says it."]],
  ["one directly under an item: lazy text", "1. one\nN. T. Wright says it.", ["ol(1,1)[p:one N. T. Wright says it.]"]],

  // Numbers, as before.
  ["numbers", "1. one\n2. two", ["ol(1,1)[p:one | p:two]"]],
  ["numbers with )", "1) one\n2) two", ["ol(1,1)[p:one | p:two]"]],
  ["numbers from 3", "3. three\n4. four", ["ol(1,3)[p:three | p:four]"]],
  ["numbers from 0", "0. zero\n1. one", ["ol(1,0)[p:zero | p:one]"]],
  ["an empty numbered item", "1. one\n2. \n3. three", ["ol(1,1)[p:one | p: | p:three]"]],

  // Every style, with either delimiter.
  ["letters with )", "a) one\nb) two", ["ol(a,1)[p:one | p:two]"]],
  ["letters with two spaces", "a.  one\nb.  two", ["ol(a,1)[p:one | p:two]"]],
  ["letters with a tab", "a.\tone\nb.\ttwo", ["ol(a,1)[p:one | p:two]"]],
  ["capitals with )", "A) one\nB) two", ["ol(A,1)[p:one | p:two]"]],
  ["capitals with two spaces", "A.  one\nB.  two", ["ol(A,1)[p:one | p:two]"]],
  ["Roman with )", "i) one\nii) two", ["ol(i,1)[p:one | p:two]"]],
  ["Roman with two spaces", "i.  one\nii.  two", ["ol(i,1)[p:one | p:two]"]],
  ["capital Roman with )", "I) one\nII) two", ["ol(I,1)[p:one | p:two]"]],
  ["capital Roman with two spaces", "I.  one\nII.  two", ["ol(I,1)[p:one | p:two]"]],
  ["a letter at the end of the line", "a.", ["ol(a,1)[p:]"]],
  ["a letter and ) at the end of the line", "a)", ["ol(a,1)[p:]"]],

  // Starting past a or i. An ambiguous first marker reads as Pandoc reads it
  // (i is Roman, other letters are letters) unless the second continues the other reading.
  ["letters from c", "c) three\nd) four", ["ol(a,3)[p:three | p:four]"]],
  ["capitals from C", "C.  three\nD.  four", ["ol(A,3)[p:three | p:four]"]],
  ["Roman from iii", "iii) three\niv) four", ["ol(i,3)[p:three | p:four]"]],
  ["Roman from v", "v) five\nvi) six", ["ol(i,5)[p:five | p:six]"]],
  ["capital Roman from V", "V.  five\nVI.  six", ["ol(I,5)[p:five | p:six]"]],
  ["Roman from x", "x) ten\nxi) eleven", ["ol(i,10)[p:ten | p:eleven]"]],
  ["Roman from c", "c) hundred\nci) next", ["ol(i,100)[p:hundred | p:next]"]],
  ["letters from i", "i) nine\nj) ten", ["ol(a,9)[p:nine | p:ten]"]],
  ["letters from v", "v) twenty-two\nw) twenty-three", ["ol(a,22)[p:twenty-two | p:twenty-three]"]],
  ["letters from cv, a numeral too", "cv) one hundred\ncw) next", ["ol(a,100)[p:one hundred | p:next]"]],
  ["i alone", "i) one", ["ol(i,1)[p:one]"]],
  ["c alone", "c) three", ["ol(a,3)[p:three]"]],
  ["v alone", "v) five", ["ol(a,22)[p:five]"]],
  ["ii alone", "ii) two", ["ol(i,2)[p:two]"]],
  ["letters past z", "y) 25\nz) 26\naa) 27\nab) 28", ["ol(a,25)[p:25 | p:26 | p:27 | p:28]"]],
  ["capitals past Z", "Z) 26\nAA) 27", ["ol(A,26)[p:26 | p:27]"]],
  ["letters starting past z", "aa) 27\nab) 28", ["ol(a,27)[p:27 | p:28]"]],
  ["a skipped letter past z is text", "z) 26\nab) 28", ["ol(a,26)[p:26 ab) 28]"]],

  // Where a list ends: a lettered or Roman list goes on only with its next
  // marker, a numbered one with any number.
  ["capitals after letters", "a) one\nb) two\n\nC.  three\nD.  four", ["ol(a,1)[p:one | p:two]", "ol(A,3)[p:three | p:four]"]],
  ["Roman after letters", "a) one\nb) two\n\ni) three\nii) four", ["ol(a,1)[p:one | p:two]", "ol(i,1)[p:three | p:four]"]],
  ["letters restarting", "a) one\nb) two\na) again", ["ol(a,1)[p:one | p:two]", "ol(a,1)[p:again]"]],
  ["letters after numbers", "1. one\na) two", ["ol(1,1)[p:one]", "ol(a,1)[p:two]"]],
  ["numbers after letters", "a) one\n1. two", ["ol(a,1)[p:one]", "ol(1,1)[p:two]"]],
  ["numbers after numbers: one list, as in CommonMark", "1. one\n2. two\n\n1. three", ["ol(1,1)[p:one | p:two | p:three]"]],
  ["numbers in any order", "1. one\n1. two\n5. three", ["ol(1,1)[p:one | p:two | p:three]"]],

  // Nested.
  ["two lists in one item", "1. one\n  a) x\n  i) y\n2. two", ["ol(1,1)[p:one + ol(a,1)[p:x] + ol(i,1)[p:y] | p:two]"]],
  ["letters inside numbers", "1. one\n  a) sub one\n  b) sub two\n2. two", ["ol(1,1)[p:one + ol(a,1)[p:sub one | p:sub two] | p:two]"]],
  ["Roman inside letters", "a) one\n  i) sub\n  ii) sub\nb) two", ["ol(a,1)[p:one + ol(i,1)[p:sub | p:sub] | p:two]"]],
  ["Roman from v, nested", "1. one\n  v) five\n  vi) six", ["ol(1,1)[p:one + ol(i,5)[p:five | p:six]]"]],
];

for (const [kind, parse] of parsers) {
  test(`${kind}: which lines open an ordered list`, () => {
    for (const [name, markdown, expected] of parseCases) {
      assert.deepEqual(parse(markdown).map(shape), expected, `${name}: ${JSON.stringify(markdown)}`);
    }
  });
}

// ---------------------------------------------------------------------------
// The export, and back.

const item = (...blocks: JSONContent[]): JSONContent => ({ type: "listItem", content: blocks });
const para = (value: string): JSONContent => ({ type: "paragraph", content: [{ type: "text", text: value }] });
const list = (attrs: Record<string, unknown>, ...items: JSONContent[]): JSONContent => ({ type: "orderedList", attrs, content: items });

test("the export writes letters and numerals with ), numbers with .", () => {
  const doc = (attrs: Record<string, unknown>) => ({ type: "doc", content: [list(attrs, item(para("one")), item(para("two")))] });
  assert.equal(docContentToMarkdown(doc({ start: 1, type: null })), "1. one\n2. two");
  assert.equal(docContentToMarkdown(doc({ start: 1, type: "a" })), "a) one\nb) two");
  assert.equal(docContentToMarkdown(doc({ start: 3, type: "A" })), "C) one\nD) two");
  assert.equal(docContentToMarkdown(doc({ start: 4, type: "i" })), "iv) one\nv) two");
  assert.equal(docContentToMarkdown(doc({ start: 1, type: "I" })), "I) one\nII) two");
  assert.equal(docContentToMarkdown(doc({ start: 0, type: null })), "0. one\n1. two");
});

const STYLES = [null, "a", "A", "i", "I"];
// 1, the usual; 3; every value whose first marker is ambiguous (i is 9, v is
// 5 or 22, x 10 or 24, l 50 or 12, c 100 or 3, d 500 or 4, m 1000 or 13);
// letters past z; a two-letter numeral that is also two letters (cv).
const STARTS = [1, 3, 4, 5, 9, 10, 12, 13, 22, 24, 26, 27, 50, 100, 105, 500, 1000];

const roundTrips: [string, JSONContent][] = [];
for (const type of STYLES) {
  for (const start of STARTS) {
    roundTrips.push([`${type ?? "1"} from ${start}`, list({ type, start }, item(para("one")), item(para("two")), item(para("three")))]);
  }
}
roundTrips.push(
  ["numbers from 0", list({ start: 0 }, item(para("zero")), item(para("one")))],
  ["letters past z", list({ type: "a", start: 25 }, ...["y", "z", "aa", "ab"].map((label) => item(para(label))))],
  ["letters, nested in numbers", list({}, item(para("one"), list({ type: "a" }, item(para("sub")), item(para("sub")))), item(para("two")))],
  ["Roman from 5, nested in letters", list({ type: "A" }, item(para("one"), list({ type: "i", start: 5 }, item(para("v")), item(para("vi")))))],
  ["numbers, nested in Roman", list({ type: "I", start: 3 }, item(para("three"), list({ start: 7 }, item(para("7")), item(para("8")))))],
  ["three levels", list({ type: "a" }, item(para("a"), list({ type: "i" }, item(para("i"), list({}, item(para("1")), item(para("2")))), item(para("ii")))))],
  ["an empty item", list({ type: "a" }, item(para("one")), item({ type: "paragraph" }), item(para("three")))],
  ["an item of two paragraphs", list({ type: "i" }, item(para("one"), para("more")), item(para("two")))],
);

const exporters: [string, Schema, (json: JSONContent) => string, (markdown: string) => JSONContent][] = [
  ["doc", pmDocContentSchema, docContentToMarkdown, (markdown) => ({ type: "doc", content: markdownToBlocks(markdown) })],
  ["comment", pmCommentContentSchema, commentContentToMarkdown, markdownToCommentContent],
  ["annotation", pmAnnotationContentSchema, annotationContentToMarkdown, markdownToAnnotationContent],
];

for (const [kind, schema, toMarkdown, fromMarkdown] of exporters) {
  test(`${kind}: an ordered list in every style, start and nesting reads back as it was`, () => {
    for (const [name, json] of roundTrips) {
      const doc = schema.nodeFromJSON({ type: "doc", content: [json, para("after")] });
      const markdown = toMarkdown(doc.toJSON());
      const back = schema.nodeFromJSON(fromMarkdown(markdown));
      assert.ok(back.eq(doc), `${name}: ${JSON.stringify(markdown)} read back as ${JSON.stringify(back.toJSON())}`);
    }
  });
}

// Two lists with nothing between them, as the editor can leave them.
const adjacent: [string, JSONContent[]][] = [
  ["letters, then Roman", [list({ type: "a" }, item(para("a")), item(para("b"))), list({ type: "i" }, item(para("i")), item(para("ii")))]],
  ["letters, then capitals from C", [list({ type: "a" }, item(para("a")), item(para("b"))), list({ type: "A", start: 3 }, item(para("C")))]],
  ["letters, restarted", [list({ type: "a" }, item(para("a")), item(para("b"))), list({ type: "a" }, item(para("a")))]],
  ["numbers, then Roman", [list({}, item(para("1"))), list({ type: "I" }, item(para("I")), item(para("II")))]],
  ["Roman, then numbers", [list({ type: "i" }, item(para("i"))), list({}, item(para("1")), item(para("2")))]],
  ["two lists in one item", [list({}, item(para("1"), list({ type: "a" }, item(para("a"))), list({ type: "i" }, item(para("i")))))]],
];

for (const [kind, schema, toMarkdown, fromMarkdown] of exporters) {
  test(`${kind}: two adjacent lists read back as two, unless both are numbered`, () => {
    for (const [name, blocks] of adjacent) {
      const doc = schema.nodeFromJSON({ type: "doc", content: blocks });
      const markdown = toMarkdown(doc.toJSON());
      const back = schema.nodeFromJSON(fromMarkdown(markdown));
      assert.ok(back.eq(doc), `${name}: ${JSON.stringify(markdown)} read back as ${JSON.stringify(back.toJSON())}`);
    }
    // Two numbered lists are one list to CommonMark, and to the package.
    const numbered = schema.nodeFromJSON({ type: "doc", content: [list({}, item(para("1"))), list({}, item(para("1")))] });
    assert.deepEqual(fromMarkdown(toMarkdown(numbered.toJSON())).content!.map(shape), ["ol(1,1)[p:1 | p:1]"]);
  });
}

// A one-item list has no second marker, so a first marker with two readings
// takes Pandoc's (docs/DOC_IMPORT.md §12). The marker drawn is the same.
test("a one-item list at an ambiguous start reads back in the other style, drawing the same marker", () => {
  const cases: [Record<string, unknown>, Record<string, unknown>][] = [
    [{ type: "i", start: 5 }, { type: "a", start: 22 }],
    [{ type: "I", start: 100 }, { type: "A", start: 3 }],
    [{ type: "a", start: 9 }, { type: "i", start: 1 }],
    [{ type: "a", start: 100 }, { type: "i", start: 105 }],
  ];
  for (const [attrs, readsAs] of cases) {
    const markdown = docContentToMarkdown({ type: "doc", content: [list(attrs, item(para("only")))] });
    const back = markdownToBlocks(markdown)[0];
    assert.deepEqual({ type: back.attrs?.type, start: back.attrs?.start ?? 1 }, readsAs, `${JSON.stringify(attrs)} → ${JSON.stringify(markdown)}`);
  }
  // And one past z opens nothing alone: its text is kept, marker and all.
  const markdown = docContentToMarkdown({ type: "doc", content: [list({ type: "a", start: 27 }, item(para("only")))] });
  assert.deepEqual(markdownToBlocks(markdown).map(shape), ["p:aa) only"]);
});

// ---------------------------------------------------------------------------
// Every surface takes the list nodes from tiptap-schema.ts.

test("every Markdown manager's list and every editor's carries the marker rule", () => {
  const lists: [string, Parameters<typeof flattenExtensions>[0]][] = [
    ["contentExtensions", contentExtensions],
    ["annotationContentExtensions", annotationContentExtensions],
    ["commentContentExtensions", commentContentExtensions],
    ["an editor's StarterKit", [StarterKit.configure({ undoRedo: false, link: EDITOR_LINK_OPTIONS })]],
  ];
  for (const [name, extensions] of lists) {
    // `configure()` copies config fields by reference, so ours are recognisable.
    const flat = flattenExtensions(extensions);
    const named = (name: string) => flat.filter((extension) => extension.name === name);
    assert.equal(named("orderedList").length, 1, `${name}: one orderedList`);
    assert.equal(named("listItem").length, 1, `${name}: one listItem`);
    assert.equal(named("orderedList")[0].config.markdownTokenizer, orderedListTokenizer, `${name}: orderedList's tokenizer`);
    assert.equal(named("orderedList")[0].config.addProseMirrorPlugins, OrderedList.config.addProseMirrorPlugins, `${name}: orderedList's paste`);
    assert.equal(named("listItem")[0].config.renderMarkdown, ListItem.config.renderMarkdown, `${name}: listItem's marker`);
  }
});

// ---------------------------------------------------------------------------
// A plain-text paste into an editor.

const pasteCases: [string, string, string | null][] = [
  ["an initial", "N. T. Wright, who says it.", null],
  ["a numeral initial", "C. S. Lewis wrote it.", null],
  ["cf.", "cf. Barth", null],
  ["St.", "St. Augustine said it.", null],
  ["a verse", "v. 23 says so.", null],
  ["letters with one space", "a. one\nb. two", null],
  ["numbers", "1. one\n2. two", "ol(1,1)[p:one | p:two]"],
  ["numbers out of order", "1. one\n3. three", null],
  ["letters with )", "a) one\nb) two", "ol(a,1)[p:one | p:two]"],
  ["capitals with two spaces", "A.  one\nB.  two", "ol(A,1)[p:one | p:two]"],
  ["Roman from v", "v) five\nvi) six", "ol(i,5)[p:five | p:six]"],
  ["letters from v", "v) five\nw) six", "ol(a,22)[p:five | p:six]"],
  ["letters past z", "z) 26\naa) 27", "ol(a,26)[p:26 | p:27]"],
  ["letters starting past z", "aa) 27\nab) 28", "ol(a,27)[p:27 | p:28]"],
  ["Windows line ends", "1. one\r\n2. two\r\n", "ol(1,1)[p:one | p:two]"],
];

test("a plain-text paste is a list only under the same rule", () => {
  for (const [name, pasted, expected] of pasteCases) {
    const parsed = parsePlainTextOrderedList(pasted);
    assert.equal(parsed && shape(parsed), expected, `${name}: ${JSON.stringify(pasted)}`);
  }
});

test("the paste plugin leaves an initial to the editor, and lists a list", () => {
  const plugin = orderedListPastePlugin();
  const paste = (pasted: string, html = "") => {
    let state = EditorState.create({ schema: pmSchema, doc: pmSchema.nodeFromJSON({ type: "doc", content: [{ type: "paragraph" }] }) });
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1)));
    const view = { get state() { return state; }, dispatch: (tr: unknown) => { state = state.apply(tr as never); } } as unknown as EditorView;
    const event = { clipboardData: { getData: (type: string) => (type === "text/plain" ? pasted : type === "text/html" ? html : "") } };
    const handled = plugin.props.handlePaste!.call(plugin, view, event as unknown as ClipboardEvent, state.doc.slice(0));
    return { handled, first: shape(state.doc.firstChild!.toJSON()) };
  };
  assert.deepEqual(paste("N. T. Wright, who says it."), { handled: false, first: "p:" });
  assert.deepEqual(paste("a) one\nb) two"), { handled: true, first: "ol(a,1)[p:one | p:two]" });
  // HTML on the clipboard is the editor's to parse, as with the package's plugin.
  assert.deepEqual(paste("a) one\nb) two", "<ol><li>one</li></ol>"), { handled: false, first: "p:" });
});
