// Etherpad's per-character document model -> TipTap/ProseMirror JSON in the
// shape `docContentExtensions` defines (src/lib/tiptap-schema.ts).
//
// Etherpad has no block structure. A pad is one flat string plus per-character
// attributes; "this line is a second-level bullet" is recorded as the attribute
// `list=bullet2` on an otherwise invisible `*` character at the head of the line
// (Etherpad's "line marker", attribute `lmkr=1`), which occupies a real position
// in the text. So the whole of this file is: split on newlines, read each line's
// block role off its marker character, and rebuild the nesting that Etherpad
// only ever represented as an integer.
//
// That last part — flat depth integers to nested bulletList/listItem trees — is
// the only genuinely non-mechanical step in the entire import, and ProseMirror
// will happily accept a malformed-but-schema-valid tree that renders wrong. It
// is covered by runMappingSelfTest() below, which the importer runs under
// --verify, because the text round-trip the importer also runs catches DROPPED
// content but cannot catch WRONGLY NESTED content.
//
// Nodes Etherpad can never produce, and which therefore never appear here:
// codeBlock, horizontalRule, hardBreak, and the marks `code` and `annotation`.

import type { JSONContent } from "@tiptap/core";
import type { Attrs, Cell } from "./changeset";

export type MapOptions = {
  // Etherpad author id -> MultiBlog User.id. Returning null (an unmapped author,
  // or Etherpad's own `a.etherpad-system`) keeps the text and drops only the
  // attribution mark.
  authorIdToUserId: (etherpadAuthorId: string) => string | null;
  // Etherpad's `list=indentN` is plain indentation with no bullet. StarterKit
  // has no indent node, so this is a choice between the closest structural node
  // and dropping the indent.
  indentAs: "blockquote" | "paragraph";
  // ep_headings2 stores `heading=h1..h6` as a line attribute. Not present in
  // every pad file; harmless when absent.
  headingAttribute: string | null;
  // Attributes to drop deliberately (and count) instead of reporting as unknown.
  ignoreAttributes: ReadonlySet<string>;
};

export type MapResult = {
  doc: JSONContent;
  // attribute key -> characters affected. Anything in here is content the import
  // would silently flatten, so the importer refuses the pad by default.
  unknown: Map<string, number>;
  ignored: Map<string, number>;
  indentLines: number;
  // A nested list that had no parent line to hang on, so an empty list item was
  // invented to hold it. Non-zero means the text round-trip will see extra blank
  // lines, so the importer reports it rather than letting the mismatch surprise.
  synthesizedItems: number;
  strayLineMarkers: number;
};

// Consumed by the line pass; never a mark. Etherpad's own
// DEFAULT_LINE_ATTRIBUTES plus `list`.
const LINE_ATTRIBUTES = new Set(["lmkr", "insertorder", "list", "start"]);

type Line = { attrs: Attrs; cells: Cell[] };

function splitLines(cells: Cell[]): Line[] {
  const lines: Line[] = [];
  let current: Cell[] = [];
  for (const cell of cells) {
    if (cell.ch === "\n") {
      lines.push({ attrs: current[0]?.attrs ?? {}, cells: current });
      current = [];
    } else {
      current.push(cell);
    }
  }
  // Etherpad's text always ends in "\n", so a non-empty remainder here would be
  // a malformed document rather than a final line without a terminator.
  if (current.length > 0) lines.push({ attrs: current[0].attrs, cells: current });
  return lines;
}

type BlockRole =
  | { kind: "paragraph" }
  | { kind: "heading"; level: number }
  | { kind: "list"; family: "bullet" | "number"; depth: number; start: number | null }
  | { kind: "indent"; depth: number };

const RE_LIST = /^(bullet|number|indent)(\d+)$/;

function marksFor(attrs: Attrs, opts: MapOptions, result: MapResult, chars: number): JSONContent["marks"] {
  const marks: NonNullable<JSONContent["marks"]> = [];
  for (const key of Object.keys(attrs)) {
    if (LINE_ATTRIBUTES.has(key)) continue;
    if (opts.headingAttribute && key === opts.headingAttribute) continue;
    if (opts.ignoreAttributes.has(key)) {
      result.ignored.set(key, (result.ignored.get(key) ?? 0) + chars);
      continue;
    }
    switch (key) {
      case "bold":
        marks.push({ type: "bold" });
        break;
      case "italic":
        marks.push({ type: "italic" });
        break;
      case "underline":
        marks.push({ type: "underline" });
        break;
      case "strikethrough":
        marks.push({ type: "strike" });
        break;
      case "hyperlink":
        marks.push({ type: "link", attrs: { href: attrs[key] } });
        break;
      case "author": {
        const userId = opts.authorIdToUserId(attrs[key]);
        if (userId) marks.push({ type: "authorHighlight", attrs: { authorId: userId } });
        break;
      }
      default:
        result.unknown.set(key, (result.unknown.get(key) ?? 0) + chars);
    }
  }
  // A stable order so two runs with the same attributes always serialize
  // identically — otherwise y-prosemirror's diff sees a change where there is none.
  const rank = ["bold", "italic", "underline", "strike", "link", "authorHighlight"];
  marks.sort((a, b) => rank.indexOf(a.type as string) - rank.indexOf(b.type as string));
  return marks.length > 0 ? marks : undefined;
}

// Adjacent cells with identical attributes become one text node. Interning in
// changeset.ts makes the comparison a pointer check.
function inlineContent(cells: Cell[], opts: MapOptions, result: MapResult): JSONContent[] {
  const out: JSONContent[] = [];
  let start = 0;
  while (start < cells.length) {
    let end = start + 1;
    while (end < cells.length && cells[end].attrs === cells[start].attrs) end += 1;
    let text = "";
    for (let i = start; i < end; i++) text += cells[i].ch;
    const marks = marksFor(cells[start].attrs, opts, result, end - start);
    out.push(marks ? { type: "text", text, marks } : { type: "text", text });
    start = end;
  }
  return out;
}

function roleOf(line: Line, opts: MapOptions, result: MapResult): BlockRole {
  const marker = line.cells[0];
  // Line attributes live on the marker character and nowhere else.
  if (!marker || marker.attrs.lmkr !== "1") return { kind: "paragraph" };
  if (marker.ch !== "*") result.strayLineMarkers += 1;

  const list = marker.attrs.list;
  if (list) {
    const m = RE_LIST.exec(list);
    if (!m) {
      result.unknown.set(`list=${list}`, (result.unknown.get(`list=${list}`) ?? 0) + 1);
      return { kind: "paragraph" };
    }
    const depth = Math.max(1, Number(m[2]));
    if (m[1] === "indent") {
      result.indentLines += 1;
      return opts.indentAs === "blockquote" ? { kind: "indent", depth } : { kind: "paragraph" };
    }
    const start = marker.attrs.start ? Number(marker.attrs.start) : null;
    return { kind: "list", family: m[1] as "bullet" | "number", depth, start: Number.isFinite(start) ? start : null };
  }

  if (opts.headingAttribute) {
    const heading = marker.attrs[opts.headingAttribute];
    const hm = heading ? /^h([1-6])$/.exec(heading) : null;
    if (hm) return { kind: "heading", level: Number(hm[1]) };
  }
  return { kind: "paragraph" };
}

type Family = "bullet" | "number" | "indent";
type OpenContainer = { family: Family; node: JSONContent };

function containerFor(family: Family, start: number | null): JSONContent {
  if (family === "indent") return { type: "blockquote", content: [] };
  if (family === "number") {
    return start !== null && start !== 1
      ? { type: "orderedList", attrs: { start }, content: [] }
      : { type: "orderedList", content: [] };
  }
  return { type: "bulletList", content: [] };
}

// Where a child block goes inside an already-open container. A list nests inside
// its parent's LAST list item (ProseMirror: listItem is `paragraph block*`), a
// blockquote takes children directly.
function appendChild(parent: OpenContainer, child: JSONContent, result: MapResult): void {
  const content = parent.node.content as JSONContent[];
  if (parent.family === "indent") {
    content.push(child);
    return;
  }
  if (content.length === 0) {
    content.push({ type: "listItem", content: [{ type: "paragraph" }] });
    result.synthesizedItems += 1;
  }
  const lastItem = content[content.length - 1];
  (lastItem.content as JSONContent[]).push(child);
}

function appendLine(parent: OpenContainer, block: JSONContent): void {
  const content = parent.node.content as JSONContent[];
  if (parent.family === "indent") content.push(block);
  else content.push({ type: "listItem", content: [block] });
}

export function cellsToProseMirror(cells: Cell[], opts: MapOptions): MapResult {
  const result: MapResult = {
    doc: { type: "doc", content: [] },
    unknown: new Map(),
    ignored: new Map(),
    indentLines: 0,
    synthesizedItems: 0,
    strayLineMarkers: 0,
  };

  const root: JSONContent[] = [];
  const stack: OpenContainer[] = [];

  for (const line of splitLines(cells)) {
    const role = roleOf(line, opts, result);
    // The marker character is structure, not content.
    const body = line.cells[0]?.attrs.lmkr === "1" ? line.cells.slice(1) : line.cells;
    const content = inlineContent(body, opts, result);

    const block: JSONContent =
      role.kind === "heading"
        ? { type: "heading", attrs: { level: role.level }, ...(content.length ? { content } : {}) }
        : { type: "paragraph", ...(content.length ? { content } : {}) };

    if (role.kind === "paragraph" || role.kind === "heading") {
      stack.length = 0;
      root.push(block);
      continue;
    }

    const family: Family = role.kind === "indent" ? "indent" : role.family;
    const depth = role.depth;
    const start = role.kind === "list" ? role.start : null;

    // Close anything deeper than this line.
    while (stack.length > depth) stack.pop();
    // At the target depth, a different family means a different list: close it
    // so a new one opens. Ancestors are left alone — a number2 line under a
    // bullet1 line is a legitimate mixed nesting Etherpad can express.
    if (stack.length === depth && stack[depth - 1].family !== family) stack.pop();
    // Open containers down to this line's depth, synthesizing any level the pad
    // skipped over.
    while (stack.length < depth) {
      const node = containerFor(family, stack.length === depth - 1 ? start : null);
      if (stack.length === 0) root.push(node);
      else appendChild(stack[stack.length - 1], node, result);
      stack.push({ family, node });
    }

    appendLine(stack[depth - 1], block);
  }

  // `doc` is `block+`; an empty pad still has its terminating newline, so this
  // is belt-and-braces rather than a real case.
  result.doc = { type: "doc", content: root.length > 0 ? root : [{ type: "paragraph" }] };
  return result;
}

// The pad text this document represents, for the importer's round-trip
// assertion: every line-bearing node contributes one line. Line markers are
// structure and were never text, so the caller compares against a marker-free
// projection of the Etherpad side.
export function proseMirrorText(doc: JSONContent): string {
  let out = "";
  const walk = (node: JSONContent): void => {
    if (node.type === "paragraph" || node.type === "heading") {
      let text = "";
      const collect = (n: JSONContent): void => {
        if (n.type === "text" && n.text) text += n.text;
        n.content?.forEach(collect);
      };
      node.content?.forEach(collect);
      out += `${text}\n`;
      return;
    }
    node.content?.forEach(walk);
  };
  doc.content?.forEach(walk);
  return out;
}

// The Etherpad text with line markers removed — the other side of the round trip.
export function cellsTextWithoutMarkers(cells: Cell[]): string {
  let out = "";
  for (const cell of cells) if (cell.attrs.lmkr !== "1") out += cell.ch;
  return out;
}

// ---------------------------------------------------------------------------
// Self-test for the flat-depth -> nested-tree conversion (see the header).
//
// This lives here rather than in a test file because the repo has no unit-test
// runner (Playwright only) and one migration script does not justify
// introducing the convention. The importer runs it under --verify, so it gates
// every run rather than being a thing somebody remembers to invoke.
// ---------------------------------------------------------------------------

const SELF_TEST_OPTIONS: MapOptions = {
  authorIdToUserId: (id) => (id === "a.known" ? "user-1" : null),
  indentAs: "blockquote",
  headingAttribute: "heading",
  ignoreAttributes: new Set(),
};

// Builds cells for one line: `marker` becomes an lmkr `*` when given.
function line(text: string, marker?: Record<string, string>, attrs: Record<string, string> = {}): Cell[] {
  const frozen = Object.freeze({ ...attrs });
  const cells: Cell[] = [];
  if (marker) cells.push({ ch: "*", attrs: Object.freeze({ lmkr: "1", ...marker }) });
  for (const ch of text) cells.push({ ch, attrs: frozen });
  cells.push({ ch: "\n", attrs: Object.freeze({}) });
  return cells;
}

function structure(node: JSONContent): string {
  const kids = node.content?.map(structure).join("") ?? "";
  if (node.type === "text") return `[${node.marks?.map((m) => m.type).join("+") ?? ""}]`;
  return `<${node.type}${kids}>`;
}

export function runMappingSelfTest(): string[] {
  const failures: string[] = [];
  const check = (name: string, cells: Cell[], expected: string) => {
    const got = structure(cellsToProseMirror(cells, SELF_TEST_OPTIONS).doc);
    if (got !== expected) failures.push(`${name}\n      expected ${expected}\n      got      ${got}`);
  };

  check("plain paragraph", line("hello"), "<doc<paragraph[]>>");
  check("empty line", line(""), "<doc<paragraph>>");
  check("heading", line("Title", { heading: "h2" }), "<doc<heading[]>>");

  check(
    "one bullet",
    [...line("a", { list: "bullet1" })],
    "<doc<bulletList<listItem<paragraph[]>>>>",
  );
  check(
    "two bullets merge into one list",
    [...line("a", { list: "bullet1" }), ...line("b", { list: "bullet1" })],
    "<doc<bulletList<listItem<paragraph[]>><listItem<paragraph[]>>>>",
  );
  check(
    "depth increase nests inside the previous item",
    [...line("a", { list: "bullet1" }), ...line("b", { list: "bullet2" })],
    "<doc<bulletList<listItem<paragraph[]><bulletList<listItem<paragraph[]>>>>>>",
  );
  check(
    "depth decrease returns to the outer list",
    [...line("a", { list: "bullet1" }), ...line("b", { list: "bullet2" }), ...line("c", { list: "bullet1" })],
    "<doc<bulletList<listItem<paragraph[]><bulletList<listItem<paragraph[]>>>><listItem<paragraph[]>>>>",
  );
  check(
    "type change at the same depth opens a new list",
    [...line("a", { list: "bullet1" }), ...line("b", { list: "number1" })],
    "<doc<bulletList<listItem<paragraph[]>>><orderedList<listItem<paragraph[]>>>>",
  );
  check(
    "mixed nesting keeps the outer family",
    [...line("a", { list: "bullet1" }), ...line("b", { list: "number2" })],
    "<doc<bulletList<listItem<paragraph[]><orderedList<listItem<paragraph[]>>>>>>",
  );
  check(
    "a skipped level is synthesized",
    [...line("a", { list: "bullet2" })],
    "<doc<bulletList<listItem<paragraph><bulletList<listItem<paragraph[]>>>>>>",
  );
  check(
    "a paragraph closes any open list",
    [...line("a", { list: "bullet1" }), ...line("b"), ...line("c", { list: "bullet1" })],
    "<doc<bulletList<listItem<paragraph[]>>><paragraph[]><bulletList<listItem<paragraph[]>>>>",
  );
  check(
    "indent becomes a nested blockquote",
    [...line("a", { list: "indent1" }), ...line("b", { list: "indent2" })],
    "<doc<blockquote<paragraph[]><blockquote<paragraph[]>>>>",
  );

  check("marks", line("x", undefined, { bold: "true", italic: "true" }), "<doc<paragraph[bold+italic]>>");
  check("known author is attributed", line("x", undefined, { author: "a.known" }), "<doc<paragraph[authorHighlight]>>");
  check("unknown author keeps the text", line("x", undefined, { author: "a.other" }), "<doc<paragraph[]>>");
  check("hyperlink", line("x", undefined, { hyperlink: "https://e.com" }), "<doc<paragraph[link]>>");

  // The marker character must never reach the content.
  const markerText = cellsToProseMirror(line("item", { list: "bullet1" }), SELF_TEST_OPTIONS);
  if (proseMirrorText(markerText.doc) !== "item\n") {
    failures.push(`line marker leaked into content: ${JSON.stringify(proseMirrorText(markerText.doc))}`);
  }

  // An ordered list carries its start number.
  const started = cellsToProseMirror(line("a", { list: "number1", start: "3" }), SELF_TEST_OPTIONS);
  const list = started.doc.content?.[0];
  if (list?.attrs?.start !== 3) failures.push(`orderedList start not carried: ${JSON.stringify(list?.attrs)}`);

  // An unknown attribute must be reported, not dropped.
  const unknown = cellsToProseMirror(line("x", undefined, { ep_fancy: "1" }), SELF_TEST_OPTIONS);
  if (unknown.unknown.get("ep_fancy") !== 1) failures.push("unknown attribute was not reported");

  return failures;
}
